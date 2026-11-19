package com.mychat.app.data.remote

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.mychat.app.model.ChatListItem
import com.mychat.app.model.ChatMessage
import com.mychat.app.model.MediaAttachment
import com.mychat.app.model.Reaction
import com.mychat.app.model.UserSettings
import com.mychat.app.model.WsMessage
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.*
import java.util.concurrent.TimeUnit

data class TypingEvent(val fromUserId: String, val isTyping: Boolean)
data class PresenceEvent(val userId: String, val isOnline: Boolean, val lastSeen: String?)
data class ReceiptEvent(val messageId: String, val deliveredAt: String?, val readAt: String?)
data class ChatListEvent(val chats: List<ChatListItem>)
data class SettingsEvent(val settings: UserSettings)
data class EditEvent(val messageId: String, val body: String, val editedAt: String?)
data class DeleteEvent(val messageId: String)

class WebSocketManager {

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null

    private var lastUrl: String? = null
    private var lastToken: String? = null

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private val _incomingMessages = MutableSharedFlow<ChatMessage>(extraBufferCapacity = 64)
    val incomingMessages: SharedFlow<ChatMessage> = _incomingMessages.asSharedFlow()

    private val _typingEvents = MutableSharedFlow<TypingEvent>(extraBufferCapacity = 32)
    val typingEvents: SharedFlow<TypingEvent> = _typingEvents.asSharedFlow()

    private val _presenceEvents = MutableSharedFlow<PresenceEvent>(extraBufferCapacity = 32)
    val presenceEvents: SharedFlow<PresenceEvent> = _presenceEvents.asSharedFlow()

    private val _receiptEvents = MutableSharedFlow<ReceiptEvent>(extraBufferCapacity = 32)
    val receiptEvents: SharedFlow<ReceiptEvent> = _receiptEvents.asSharedFlow()

    private val _chatListEvents = MutableSharedFlow<ChatListEvent>(extraBufferCapacity = 8)
    val chatListEvents: SharedFlow<ChatListEvent> = _chatListEvents.asSharedFlow()

    private val _settingsEvents = MutableSharedFlow<SettingsEvent>(extraBufferCapacity = 4)
    val settingsEvents: SharedFlow<SettingsEvent> = _settingsEvents.asSharedFlow()

    private val _editEvents = MutableSharedFlow<EditEvent>(extraBufferCapacity = 32)
    val editEvents: SharedFlow<EditEvent> = _editEvents.asSharedFlow()

    private val _deleteEvents = MutableSharedFlow<DeleteEvent>(extraBufferCapacity = 32)
    val deleteEvents: SharedFlow<DeleteEvent> = _deleteEvents.asSharedFlow()

    var onUrlRefreshNeeded: (suspend () -> String?)? = null

    fun connect(baseUrl: String, token: String) {
        lastUrl = baseUrl
        lastToken = token
        disconnectInternal(clearCredentials = false)

        val cleanBase = baseUrl.trimEnd('/')
        val wsUrl = if (cleanBase.startsWith("https://")) {
            cleanBase.replace("https://", "wss://")
        } else {
            cleanBase.replace("http://", "ws://")
        } + "/ws?access_token=$token&token=$token"

        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                _isConnected.value = true
                startHeartbeat()
                // Request sync after connect
                webSocket.send(gson.toJson(mapOf("type" to "sync")))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val jsonObj = gson.fromJson(text, JsonObject::class.java) ?: return
                    val type = jsonObj.get("type")?.asString ?: ""

                    when (type) {
                        "ready", "pong" -> {
                            _isConnected.value = true
                        }
                        "sync:required" -> {
                            _isConnected.value = true
                            webSocket.send(gson.toJson(mapOf("type" to "sync")))
                        }
                        "chat:list" -> {
                            val wsMsg = gson.fromJson(text, WsMessage::class.java)
                            val chats = wsMsg.chats ?: emptyList()
                            scope.launch { _chatListEvents.emit(ChatListEvent(chats)) }
                        }
                        "settings" -> {
                            val wsMsg = gson.fromJson(text, WsMessage::class.java)
                            wsMsg.settings?.let { s ->
                                scope.launch { _settingsEvents.emit(SettingsEvent(s)) }
                            }
                        }
                        "chat_message", "message" -> {
                            parseAndEmitMessage(jsonObj)
                        }
                        "delivered", "read" -> {
                            val msgId = jsonObj.get("message_id")?.asString ?: ""
                            val delAt = jsonObj.get("delivered_at")?.asString
                            val readAt = jsonObj.get("read_at")?.asString
                            if (msgId.isNotBlank()) {
                                scope.launch { _receiptEvents.emit(ReceiptEvent(msgId, delAt, readAt)) }
                            }
                        }
                        "message:edited" -> {
                            val msgId = jsonObj.get("message_id")?.asString ?: ""
                            val body = jsonObj.get("body")?.asString ?: ""
                            val editedAt = jsonObj.get("edited_at")?.asString
                            if (msgId.isNotBlank()) {
                                scope.launch { _editEvents.emit(EditEvent(msgId, body, editedAt)) }
                            }
                        }
                        "message:deleted" -> {
                            val msgId = jsonObj.get("message_id")?.asString ?: ""
                            if (msgId.isNotBlank()) {
                                scope.launch { _deleteEvents.emit(DeleteEvent(msgId)) }
                            }
                        }
                        "typing" -> {
                            val from = jsonObj.get("from")?.asString ?: ""
                            val active = jsonObj.get("active")?.asBoolean ?: false
                            if (from.isNotBlank()) {
                                scope.launch { _typingEvents.emit(TypingEvent(from, active)) }
                            }
                        }
                        "presence" -> {
                            val uid = jsonObj.get("user_id")?.asString ?: ""
                            val online = jsonObj.get("online")?.asBoolean ?: false
                            val lastSeen = jsonObj.get("last_seen")?.asString
                            if (uid.isNotBlank()) {
                                scope.launch { _presenceEvents.emit(PresenceEvent(uid, online, lastSeen)) }
                            }
                        }
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                _isConnected.value = false
                stopHeartbeat()
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                _isConnected.value = false
                stopHeartbeat()
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _isConnected.value = false
                stopHeartbeat()
                scheduleReconnect()
            }
        })
    }

    private fun parseAndEmitMessage(jsonObj: JsonObject) {
        val msgObj = if (jsonObj.has("message") && jsonObj.get("message").isJsonObject) {
            jsonObj.getAsJsonObject("message")
        } else jsonObj

        val sender = msgObj.get("sender_id")?.asString
            ?: msgObj.get("senderId")?.asString ?: ""
        val receiver = msgObj.get("receiver_id")?.asString
            ?: msgObj.get("receiverId")?.asString ?: ""
        val body = msgObj.get("body")?.asString
            ?: msgObj.get("text")?.asString
            ?: msgObj.get("content")?.asString ?: ""
        val msgId = msgObj.get("id")?.asString ?: System.currentTimeMillis().toString()
        val deliveredAt = msgObj.get("delivered_at")?.asString
        val readAt = msgObj.get("read_at")?.asString
        val createdAt = msgObj.get("created_at")?.asString
        val senderName = msgObj.get("sender_name")?.asString
        val replyToId = msgObj.get("reply_to_id")?.asLong
        val replySenderName = msgObj.get("reply_sender_name")?.asString
        val replyBody = msgObj.get("reply_body")?.asString
        val editedAt = msgObj.get("edited_at")?.asString
        val forwardedFromId = msgObj.get("forwarded_from_id")?.asLong

        // Parse media
        var media: MediaAttachment? = null
        if (msgObj.has("media") && msgObj.get("media").isJsonObject) {
            try {
                media = gson.fromJson(msgObj.getAsJsonObject("media"), MediaAttachment::class.java)
            } catch (_: Exception) {}
        }

        // Parse reactions
        var reactions = emptyList<Reaction>()
        if (msgObj.has("reactions") && msgObj.get("reactions").isJsonArray) {
            try {
                val arr = msgObj.getAsJsonArray("reactions")
                reactions = arr.map { gson.fromJson(it, Reaction::class.java) }
            } catch (_: Exception) {}
        }

        if (body.isNotBlank() || media != null) {
            val msg = ChatMessage(
                id = msgId,
                senderId = sender,
                receiverId = receiver,
                senderName = senderName,
                text = body,
                createdAt = createdAt,
                editedAt = editedAt,
                deliveredAt = deliveredAt,
                readAt = readAt,
                replyToId = replyToId,
                replySenderName = replySenderName,
                replyBody = replyBody,
                forwardedFromId = forwardedFromId,
                media = media,
                reactions = reactions
            )
            scope.launch { _incomingMessages.emit(msg) }
        }
    }

    fun sendMessage(receiverId: String, text: String, replyToId: Long? = null, mediaId: String? = null): Boolean {
        val reqId = "msg_${System.currentTimeMillis()}"
        val payload = mutableMapOf<String, Any>(
            "type" to "message",
            "receiver_id" to (receiverId.toLongOrNull() ?: receiverId),
            "body" to text,
            "request_id" to reqId
        )
        if (replyToId != null) payload["reply_to_id"] = replyToId
        if (mediaId != null) payload["media_id"] = mediaId
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun markChatRead(userId: String): Boolean {
        val payload = mapOf(
            "type" to "chat:mark-read",
            "user_id" to (userId.toLongOrNull() ?: userId)
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun subscribePresence(userId: String): Boolean {
        val payload = mapOf(
            "type" to "presence:subscribe",
            "user_ids" to listOf(userId.toLongOrNull() ?: userId)
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendTyping(receiverId: String, isTyping: Boolean): Boolean {
        val payload = mapOf(
            "type" to "typing",
            "to" to (receiverId.toLongOrNull() ?: receiverId),
            "active" to isTyping
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendVisibility(visible: Boolean): Boolean {
        val payload = mapOf("type" to "app:visibility", "visible" to visible)
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendEdit(messageId: String, newText: String): Boolean {
        val payload = mapOf(
            "type" to "message:edit",
            "message_id" to (messageId.toLongOrNull() ?: messageId),
            "body" to newText
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendDelete(messageId: String, deleteForAll: Boolean): Boolean {
        val payload = mapOf(
            "type" to "message:delete",
            "message_id" to (messageId.toLongOrNull() ?: messageId),
            "scope" to (if (deleteForAll) "everyone" else "me"),
            "for_all" to deleteForAll
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendDeliveredAck(messageId: String): Boolean {
        val payload = mapOf(
            "type" to "msg:ack",
            "message_id" to (messageId.toLongOrNull() ?: messageId)
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    fun sendClearChat(userId: String): Boolean {
        val payload = mapOf(
            "type" to "chat:clear",
            "user_id" to (userId.toLongOrNull() ?: userId)
        )
        return webSocket?.send(gson.toJson(payload)) ?: false
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(8000)
                if (_isConnected.value && webSocket != null) {
                    webSocket?.send(gson.toJson(mapOf("type" to "app:heartbeat", "ts" to System.currentTimeMillis())))
                }
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun scheduleReconnect() {
        val token = lastToken ?: return
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            var delayMs = 2500L
            while (!_isConnected.value && isActive && !lastToken.isNullOrBlank()) {
                delay(delayMs)
                if (_isConnected.value) break
                val freshUrl = try { onUrlRefreshNeeded?.invoke() } catch (_: Exception) { null } ?: lastUrl
                if (!freshUrl.isNullOrBlank()) {
                    connect(freshUrl, token)
                }
                delayMs = (delayMs * 1.5).toLong().coerceAtMost(15000L)
            }
        }
    }

    private fun disconnectInternal(clearCredentials: Boolean = false) {
        stopHeartbeat()
        reconnectJob?.cancel()
        reconnectJob = null
        try { webSocket?.close(1000, "Disconnect") } catch (_: Exception) {}
        webSocket = null
        _isConnected.value = false
        if (clearCredentials) {
            lastUrl = null
            lastToken = null
        }
    }

    fun disconnect() = disconnectInternal(clearCredentials = true)
}
