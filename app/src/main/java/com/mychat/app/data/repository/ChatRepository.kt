package com.mychat.app.data.repository

import com.mychat.app.data.local.TokenManager
import com.mychat.app.data.remote.ApiService
import com.mychat.app.data.remote.GitHubBackendUrlService
import com.mychat.app.data.remote.PresenceEvent
import com.mychat.app.data.remote.WebSocketManager
import com.mychat.app.model.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.converter.scalars.ScalarsConverterFactory
import java.util.concurrent.TimeUnit

class ChatRepository(private val tokenManager: TokenManager) {

    private val GITHUB_BACKEND_URL_RAW =
        "https://raw.githubusercontent.com/RaunakPratap/chat.app/main/backend-url.txt"

    val webSocketManager = WebSocketManager()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var currentBaseUrl: String = "http://10.0.2.2:8000/"
    private var apiService: ApiService? = null

    // --- State flows ---
    private val _messagesState = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val messagesState: StateFlow<Map<String, List<ChatMessage>>> = _messagesState.asStateFlow()

    private val _presenceState = MutableStateFlow<Map<String, PresenceEvent>>(emptyMap())
    val presenceState: StateFlow<Map<String, PresenceEvent>> = _presenceState.asStateFlow()

    private val _typingState = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val typingState: StateFlow<Map<String, Boolean>> = _typingState.asStateFlow()

    private val _chatListState = MutableStateFlow<List<ChatListItem>>(emptyList())
    val chatListState: StateFlow<List<ChatListItem>> = _chatListState.asStateFlow()

    private val _settingsState = MutableStateFlow<UserSettings>(UserSettings())
    val settingsState: StateFlow<UserSettings> = _settingsState.asStateFlow()

    private val _statusList = MutableStateFlow<List<StatusItem>>(emptyList())
    val statusList: StateFlow<List<StatusItem>> = _statusList.asStateFlow()

    private val _myUser = MutableStateFlow<User?>(null)
    val myUser: StateFlow<User?> = _myUser.asStateFlow()

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request().newBuilder()
                .header("User-Agent", "MyChat-Android/1.0")
                .build()
            chain.proceed(req)
        }
        .build()

    init {
        webSocketManager.onUrlRefreshNeeded = {
            resolveBaseUrl()
        }

        // Active background sync: checks GitHub for tunnel/backend URL changes and auto-reconnects
        scope.launch {
            while (isActive) {
                delay(10000)
                try {
                    checkAndApplyBackendUrlUpdate()
                } catch (_: Exception) {}
            }
        }

        scope.launch {
            webSocketManager.incomingMessages.collect { msg ->
                val myId = tokenManager.userIdFlow.firstOrNull() ?: ""
                val isMine = msg.senderId == myId || msg.isMine
                val peerId = if (isMine) msg.receiverId else msg.senderId
                if (peerId.isNotBlank()) {
                    addMessageToState(peerId, msg.copy(isMine = isMine))
                }
                // Instant delivery receipt ACK back to server
                if (!isMine && msg.id.isNotBlank() && !msg.id.startsWith("pending_")) {
                    webSocketManager.sendDeliveredAck(msg.id)
                }
            }
        }
        scope.launch {
            webSocketManager.presenceEvents.collect { evt ->
                val current = _presenceState.value.toMutableMap()
                current[evt.userId] = evt
                _presenceState.value = current
            }
        }
        scope.launch {
            webSocketManager.typingEvents.collect { evt ->
                val current = _typingState.value.toMutableMap()
                current[evt.fromUserId] = evt.isTyping
                _typingState.value = current
            }
        }
        scope.launch {
            webSocketManager.receiptEvents.collect { evt ->
                updateReceiptInState(evt.messageId, evt.deliveredAt, evt.readAt)
            }
        }
        scope.launch {
            webSocketManager.editEvents.collect { evt ->
                updateMessageEditInState(evt.messageId, evt.body, evt.editedAt)
            }
        }
        scope.launch {
            webSocketManager.deleteEvents.collect { evt ->
                removeMessageFromState(evt.messageId)
            }
        }
        scope.launch {
            webSocketManager.chatListEvents.collect { evt ->
                _chatListState.value = evt.chats
            }
        }
        scope.launch {
            webSocketManager.settingsEvents.collect { evt ->
                _settingsState.value = evt.settings
            }
        }
    }

    // ---- Backend URL Resolution ----
    suspend fun resolveBaseUrl(): String = withContext(Dispatchers.IO) {
        val fetchedUrl = fetchUrlFromGitHub()
        var targetUrl = if (!fetchedUrl.isNullOrBlank()) {
            fetchedUrl.trim()
        } else {
            val savedUrl = tokenManager.serverUrlFlow.firstOrNull()
            if (!savedUrl.isNullOrBlank()) savedUrl.trim() else "http://10.0.2.2:8000"
        }
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            targetUrl = "https://$targetUrl"
        }
        val formatted = if (!targetUrl.endsWith("/")) "$targetUrl/" else targetUrl
        currentBaseUrl = formatted
        initApiService(formatted)
        try { tokenManager.saveServerUrl(formatted) } catch (_: Exception) {}
        formatted
    }

    private fun initApiService(baseUrl: String) {
        val retrofit = Retrofit.Builder()
            .baseUrl(baseUrl)
            .addConverterFactory(GsonConverterFactory.create())
            .client(okHttpClient)
            .build()
        apiService = retrofit.create(ApiService::class.java)
    }

    private suspend fun fetchUrlFromGitHub(): String? {
        val noCacheClient = okHttpClient.newBuilder()
            .addInterceptor { chain ->
                val req = chain.request().newBuilder()
                    .header("User-Agent", "MyChat-Android/1.0")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .header("Pragma", "no-cache")
                    .build()
                chain.proceed(req)
            }
            .build()

        // 1. Try GitHub REST API first (direct JSON, bypasses Fastly 5-minute CDN cache)
        try {
            val apiUrl = "https://api.github.com/repos/RaunakPratap/chat.app/contents/backend-url.txt?ts=${System.currentTimeMillis()}"
            val retrofit = Retrofit.Builder()
                .baseUrl("https://api.github.com/")
                .addConverterFactory(GsonConverterFactory.create())
                .client(noCacheClient)
                .build()
            val service = retrofit.create(GitHubBackendUrlService::class.java)
            val resp = service.fetchBackendUrlApi(apiUrl)
            if (resp.isSuccessful && resp.body()?.content != null) {
                val b64 = resp.body()!!.content!!.replace("\n", "").replace("\r", "").trim()
                val decoded = String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)).trim()
                val clean = cleanTargetUrl(decoded)
                if (!clean.isNullOrBlank()) return clean
            }
        } catch (_: Exception) {}

        // 2. Fallback to raw.githubusercontent.com
        return try {
            val cacheBustingUrl = "$GITHUB_BACKEND_URL_RAW?ts=${System.currentTimeMillis()}"
            val retrofit = Retrofit.Builder()
                .baseUrl("https://raw.githubusercontent.com/")
                .addConverterFactory(ScalarsConverterFactory.create())
                .client(noCacheClient)
                .build()
            val service = retrofit.create(GitHubBackendUrlService::class.java)
            val rawResult = service.fetchBackendUrl(cacheBustingUrl).trim()
            cleanTargetUrl(rawResult)
        } catch (e: Exception) {
            null
        }
    }

    private fun cleanTargetUrl(raw: String): String? {
        val cleanUrl = raw.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.contains("trycloudflare.com") || it.startsWith("http://") || it.startsWith("https://") }
            ?: raw.trim()
        return if (cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")) cleanUrl
        else if (cleanUrl.isNotBlank()) "https://$cleanUrl"
        else null
    }

    // ---- Auth ----
    suspend fun login(phone: String, password: String): AuthResponse = withContext(Dispatchers.IO) {
        resolveBaseUrl()
        try {
            val res = apiService?.login(AuthRequest(phone = phone, password = password))
            if (res != null && res.isSuccessful && res.body() != null) {
                val body = res.body()!!
                if (body.ok && body.token != null && body.user != null) {
                    tokenManager.saveSession(body.token, body.user.id, body.user.phone)
                    _myUser.value = body.user
                    webSocketManager.connect(currentBaseUrl, body.token)
                }
                body
            } else {
                val errorMsg = parseErrorMessage(res?.errorBody()?.string()) ?: "Login failed"
                AuthResponse(ok = false, error = errorMsg)
            }
        } catch (e: Exception) {
            AuthResponse(ok = false, error = e.localizedMessage ?: "Connection error")
        }
    }

    suspend fun register(phone: String, password: String, name: String): AuthResponse =
        withContext(Dispatchers.IO) {
            resolveBaseUrl()
            try {
                val res = apiService?.register(AuthRequest(phone = phone, password = password, name = name))
                if (res != null && res.isSuccessful && res.body() != null) {
                    val body = res.body()!!
                    if (body.ok && body.token != null && body.user != null) {
                        tokenManager.saveSession(body.token, body.user.id, body.user.phone)
                        _myUser.value = body.user
                        webSocketManager.connect(currentBaseUrl, body.token)
                    }
                    body
                } else {
                    val errorMsg = parseErrorMessage(res?.errorBody()?.string()) ?: "Registration failed"
                    AuthResponse(ok = false, error = errorMsg)
                }
            } catch (e: Exception) {
                AuthResponse(ok = false, error = e.localizedMessage ?: "Connection error")
            }
        }

    suspend fun forgotDevice(phone: String, token: String, newPass: String): GenericResponse =
        withContext(Dispatchers.IO) {
            resolveBaseUrl()
            try {
                val res = apiService?.forgotDevice(
                    ForgotDeviceRequest(phone = phone, deviceRecoveryToken = token, newPassword = newPass)
                )
                if (res != null && res.isSuccessful && res.body() != null) res.body()!!
                else GenericResponse(ok = false, error = "Password recovery failed")
            } catch (e: Exception) {
                GenericResponse(ok = false, error = e.localizedMessage ?: "Connection error")
            }
        }

    suspend fun logout() {
        try {
            val t = tokenManager.tokenFlow.firstOrNull()
            if (!t.isNullOrBlank()) {
                apiService?.logout("Bearer $t")
            }
        } catch (_: Exception) {}
        tokenManager.clearSession()
        webSocketManager.disconnect()
        _chatListState.value = emptyList()
        _messagesState.value = emptyMap()
        _myUser.value = null
    }

    // ---- Me ----
    suspend fun fetchMe(): User? = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext null
        try {
            val res = apiService?.getMe("Bearer $t")
            if (res?.isSuccessful == true) {
                res.body()?.user?.also { _myUser.value = it }
            } else null
        } catch (_: Exception) { null }
    }

    // ---- Chat List ----
    suspend fun fetchChats(): List<ChatListItem> = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext emptyList()
        try {
            val res = apiService?.getChats("Bearer $t")
            if (res?.isSuccessful == true) {
                val chats = res.body()?.chats ?: emptyList()
                _chatListState.value = chats
                chats
            } else emptyList()
        } catch (_: Exception) { emptyList() }
    }

    // ---- Messages ----
    suspend fun fetchMessages(userId: String, before: Long? = null): List<ChatMessage> =
        withContext(Dispatchers.IO) {
            val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext emptyList()
            val myId = tokenManager.userIdFlow.firstOrNull() ?: ""
            try {
                val res = apiService?.getMessages(userId, before, 40, "Bearer $t")
                if (res?.isSuccessful == true) {
                    val msgs = res.body()?.messages ?: emptyList()
                    val processed = msgs.map { m ->
                        m.copy(
                            isMine = m.senderId == myId,
                            timestamp = parseIsoToMillis(m.createdAt) ?: m.timestamp
                        )
                    }
                    if (before == null) {
                        // Replace full history
                        val current = _messagesState.value.toMutableMap()
                        current[userId] = processed
                        _messagesState.value = current
                    } else {
                        // Prepend older messages
                        val current = _messagesState.value.toMutableMap()
                        val existing = current[userId] ?: emptyList()
                        current[userId] = processed + existing
                        _messagesState.value = current
                    }
                    processed
                } else emptyList()
            } catch (_: Exception) { emptyList() }
        }

    fun sendMessage(receiverId: String, text: String, myId: String, replyToId: Long? = null) {
        if (text.isBlank()) return
        webSocketManager.sendMessage(receiverId, text, replyToId)
        val newMsg = ChatMessage(
            id = "pending_${System.currentTimeMillis()}",
            senderId = myId,
            receiverId = receiverId,
            text = text,
            timestamp = System.currentTimeMillis(),
            isMine = true,
            replyToId = replyToId
        )
        addMessageToState(receiverId, newMsg)
    }

    fun markChatAsRead(targetUserId: String) {
        webSocketManager.markChatRead(targetUserId)
        webSocketManager.subscribePresence(targetUserId)
    }

    fun sendTyping(receiverId: String, isTyping: Boolean) {
        webSocketManager.sendTyping(receiverId, isTyping)
    }

    // ---- Message Actions (Edit, Delete, React, Clear) ----
    suspend fun editMessage(chatUserId: String, messageId: String, newText: String): Boolean = withContext(Dispatchers.IO) {
        val current = _messagesState.value.toMutableMap()
        val list = current[chatUserId]?.map { msg ->
            if (msg.id == messageId) {
                val nowStr = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
                msg.copy(text = newText, editedAt = nowStr)
            } else msg
        } ?: return@withContext false
        current[chatUserId] = list
        _messagesState.value = current
        webSocketManager.sendEdit(messageId, newText)
        true
    }

    suspend fun deleteMessage(chatUserId: String, messageId: String, deleteForAll: Boolean): Boolean = withContext(Dispatchers.IO) {
        val current = _messagesState.value.toMutableMap()
        if (deleteForAll) {
            val list = current[chatUserId]?.map { msg ->
                if (msg.id == messageId) msg.copy(text = "🗑️ This message was deleted", editedAt = "deleted")
                else msg
            } ?: return@withContext false
            current[chatUserId] = list
        } else {
            val list = current[chatUserId]?.filter { it.id != messageId } ?: return@withContext false
            current[chatUserId] = list
        }
        _messagesState.value = current
        webSocketManager.sendDelete(messageId, deleteForAll)
        true
    }

    suspend fun reactToMessage(messageId: String, emoji: String): Boolean = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext false
        try {
            apiService?.sendReaction(mapOf("message_id" to (messageId.toLongOrNull() ?: messageId), "emoji" to emoji), "Bearer $t")
            true
        } catch (_: Exception) { false }
    }

    // ---- Clear Chat & Emergency Panic Wipe ----
    suspend fun clearChat(chatUserId: String): Boolean = withContext(Dispatchers.IO) {
        val currentMsgs = _messagesState.value.toMutableMap()
        currentMsgs.remove(chatUserId)
        _messagesState.value = currentMsgs

        // Update last message in chat list
        val currentChats = _chatListState.value.map { item ->
            if (item.id == chatUserId) item.copy(lastMessage = null, lastMessageAt = null, unreadCount = 0)
            else item
        }
        _chatListState.value = currentChats

        webSocketManager.sendClearChat(chatUserId)
        true
    }

    suspend fun panicWipeChats(
        mode: String, // "current", "selected", "all"
        currentChatUserId: String? = null,
        selectedUserIds: Set<String> = emptySet()
    ): Int = withContext(Dispatchers.IO) {
        var wipedCount = 0
        when (mode) {
            "current" -> {
                if (!currentChatUserId.isNullOrBlank()) {
                    clearChat(currentChatUserId)
                    wipedCount = 1
                }
            }
            "selected" -> {
                selectedUserIds.forEach { uid ->
                    clearChat(uid)
                    wipedCount++
                }
            }
            "all" -> {
                val allChatIds = _chatListState.value.map { it.id }.toSet() + _messagesState.value.keys
                allChatIds.forEach { uid ->
                    webSocketManager.sendClearChat(uid)
                }
                _messagesState.value = emptyMap()
                _chatListState.value = _chatListState.value.map {
                    it.copy(lastMessage = null, lastMessageAt = null, unreadCount = 0)
                }
                wipedCount = allChatIds.size.coerceAtLeast(1)
            }
        }
        wipedCount
    }

    // ---- Settings ----
    suspend fun fetchSettings(): UserSettings? = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext null
        try {
            val res = apiService?.getSettings("Bearer $t")
            if (res?.isSuccessful == true) {
                res.body()?.settings?.also { _settingsState.value = it }
            } else null
        } catch (_: Exception) { null }
    }

    suspend fun updateSettings(key: String, value: Any): Boolean = withContext(Dispatchers.IO) {
        val current = _settingsState.value
        val updatedMap = when (key) {
            "read_receipts" -> current.copy(readReceipts = value as? Boolean ?: true)
            "typing_indicator" -> current.copy(typingIndicator = value as? Boolean ?: true)
            "notifications" -> current.copy(notifications = value as? Boolean ?: true)
            "notification_preview" -> current.copy(notificationPreview = value as? Boolean ?: true)
            "notification_vibrate" -> current.copy(notificationVibrate = value as? Boolean ?: true)
            "enter_to_send" -> current.copy(enterToSend = value as? Boolean ?: true)
            "animations" -> current.copy(animations = value as? Boolean ?: true)
            "last_seen_visibility" -> current.copy(lastSeenVisibility = value as? String ?: "everyone")
            "dp_visibility" -> current.copy(dpVisibility = value as? String ?: "everyone")
            "online_visibility" -> current.copy(onlineVisibility = value as? String ?: "everyone")
            "status_visibility" -> current.copy(statusVisibility = value as? String ?: "everyone")
            "theme" -> current.copy(theme = value as? String ?: "system")
            "wallpaper" -> current.copy(wallpaper = value as? String ?: "classic")
            "compact_bubbles" -> current.copy(compactBubbles = value as? Boolean ?: false)
            "glass_ui" -> current.copy(glassUi = value as? Boolean ?: true)
            "message_density" -> current.copy(messageDensity = value as? String ?: "comfortable")
            else -> current
        }
        _settingsState.value = updatedMap

        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext false
        try {
            val res = apiService?.updateSettings(mapOf(key to value), "Bearer $t")
            if (res?.isSuccessful == true && res.body()?.settings != null) {
                _settingsState.value = res.body()?.settings!!
            }
            res?.isSuccessful == true
        } catch (_: Exception) { false }
    }

    // ---- Status ----
    suspend fun fetchStatuses(): List<StatusItem> = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext emptyList()
        try {
            val res = apiService?.getStatuses("Bearer $t")
            if (res?.isSuccessful == true) {
                val statuses = res.body()?.statuses ?: emptyList()
                _statusList.value = statuses
                statuses
            } else emptyList()
        } catch (_: Exception) { emptyList() }
    }

    suspend fun postStatus(body: String): Boolean = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext false
        try {
            val res = apiService?.postStatus(mapOf("body" to body), "Bearer $t")
            res?.isSuccessful == true
        } catch (_: Exception) { false }
    }

    // ---- Search ----
    suspend fun searchUsers(query: String): List<User> = withContext(Dispatchers.IO) {
        resolveBaseUrl()
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext emptyList()
        val myId = tokenManager.userIdFlow.firstOrNull() ?: ""
        try {
            val res = apiService?.searchUsers(query, "Bearer $t")
            if (res?.isSuccessful == true) {
                res.body()?.users?.filter { it.id != myId }?.distinctBy { it.id } ?: emptyList()
            } else emptyList()
        } catch (_: Exception) { emptyList() }
    }

    // ---- FCM Device Registration ----
    suspend fun registerFcmToken(fcmToken: String) = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext
        try {
            apiService?.registerDevice(DeviceRegisterRequest(token = fcmToken), "Bearer $t")
        } catch (_: Exception) {}
    }

    // ---- DP Upload ----
    suspend fun uploadDp(fileBytes: ByteArray, fileName: String): String? = withContext(Dispatchers.IO) {
        val t = tokenManager.tokenFlow.firstOrNull() ?: return@withContext null
        try {
            val reqBody = fileBytes.toRequestBody("image/*".toMediaTypeOrNull())
            val part = okhttp3.MultipartBody.Part.createFormData("file", fileName, reqBody)
            val res = apiService?.uploadDp(part, "Bearer $t")
            if (res?.isSuccessful == true && res.body()?.ok == true) {
                val newDp = res.body()?.dp
                if (newDp != null) {
                    _myUser.value = _myUser.value?.copy(dp = newDp)
                }
                newDp
            } else null
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    // ---- Helpers ----
    fun addMessageToState(chatUserId: String, message: ChatMessage) {
        val current = _messagesState.value.toMutableMap()
        val list = current[chatUserId]?.toMutableList() ?: mutableListOf()

        // If this is a confirmed server message (not pending) from me, replace matching pending message
        val pendingIndex = if (!message.id.startsWith("pending_") && message.isMine) {
            list.indexOfFirst { it.id.startsWith("pending_") && it.text == message.text }
        } else -1

        if (pendingIndex >= 0) {
            list[pendingIndex] = message
        } else {
            val existingIndex = list.indexOfFirst { it.id == message.id }
            if (existingIndex >= 0) {
                list[existingIndex] = message
            } else {
                list.add(message)
            }
        }
        current[chatUserId] = list.sortedBy { it.timestamp }
        _messagesState.value = current
    }

    private fun updateReceiptInState(messageId: String, deliveredAt: String?, readAt: String?) {
        val current = _messagesState.value.toMutableMap()
        var changed = false
        for ((chatId, list) in current) {
            val updatedList = list.map { msg ->
                if (msg.id == messageId) {
                    changed = true
                    msg.copy(
                        deliveredAt = deliveredAt ?: msg.deliveredAt,
                        readAt = readAt ?: msg.readAt
                    )
                } else msg
            }
            if (changed) {
                current[chatId] = updatedList
                break
            }
        }
        if (changed) _messagesState.value = current
    }

    private fun updateMessageEditInState(messageId: String, newBody: String, editedAt: String?) {
        val current = _messagesState.value.toMutableMap()
        var changed = false
        for ((chatId, list) in current) {
            val updatedList = list.map { msg ->
                if (msg.id == messageId) {
                    changed = true
                    val timeStr = editedAt ?: java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
                    msg.copy(text = newBody, editedAt = timeStr)
                } else msg
            }
            if (changed) {
                current[chatId] = updatedList
                break
            }
        }
        if (changed) _messagesState.value = current
    }

    private fun removeMessageFromState(messageId: String) {
        val current = _messagesState.value.toMutableMap()
        var changed = false
        for ((chatId, list) in current) {
            if (list.any { it.id == messageId }) {
                current[chatId] = list.filter { it.id != messageId }
                changed = true
                break
            }
        }
        if (changed) _messagesState.value = current
    }

    suspend fun checkAndApplyBackendUrlUpdate(): Boolean = withContext(Dispatchers.IO) {
        val fetched = fetchUrlFromGitHub() ?: return@withContext false
        val clean = if (!fetched.startsWith("http://") && !fetched.startsWith("https://")) "https://$fetched" else fetched
        val formatted = if (!clean.endsWith("/")) "$clean/" else clean
        val urlChanged = formatted != currentBaseUrl && formatted.isNotBlank()
        val isDisconnected = !webSocketManager.isConnected.value
        if ((urlChanged || isDisconnected) && formatted.isNotBlank()) {
            currentBaseUrl = formatted
            initApiService(formatted)
            tokenManager.saveServerUrl(formatted)
            val token = tokenManager.tokenFlow.firstOrNull()
            if (!token.isNullOrBlank()) {
                webSocketManager.connect(formatted, token)
                if (urlChanged) {
                    fetchMe()
                    fetchChats()
                }
            }
            true
        } else false
    }

    private fun parseErrorMessage(json: String?): String? {
        if (json.isNullOrBlank()) return null
        return try {
            val gson = com.google.gson.Gson()
            val obj = gson.fromJson(json, Map::class.java)
            obj["error"] as? String
        } catch (_: Exception) { null }
    }

    private fun parseIsoToMillis(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return try {
            java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault())
                .parse(iso.substringBefore("."))?.time
        } catch (_: Exception) { null }
    }
}
