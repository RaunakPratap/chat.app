package com.mychat.app.model

import com.google.gson.annotations.SerializedName

data class User(
    val id: String = "",
    val phone: String = "",
    val name: String? = null,
    val dp: String? = null,
    @SerializedName("last_seen", alternate = ["lastSeen"])
    val lastSeen: String? = null,
    @SerializedName("online", alternate = ["isOnline"])
    val isOnline: Boolean = false
) {
    val displayName: String
        get() = if (!name.isNullOrBlank()) name else if (phone.isNotBlank()) phone else "User #$id"
}

data class AuthRequest(
    val phone: String,
    val password: String,
    val name: String? = null
)

data class AuthResponse(
    val ok: Boolean = false,
    @SerializedName("access_token", alternate = ["token"])
    val token: String? = null,
    val user: User? = null,
    val error: String? = null
)

data class ForgotDeviceRequest(
    val phone: String,
    @SerializedName("device_recovery_token")
    val deviceRecoveryToken: String,
    @SerializedName("new_password")
    val newPassword: String
)

data class GenericResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null
)

data class HealthResponse(val ok: Boolean = false)

data class UserSearchResponse(
    val ok: Boolean = false,
    val users: List<User> = emptyList(),
    val error: String? = null
)

// ---- Chat List (from /api/chats) ----
data class ChatListItem(
    val id: String = "",
    val phone: String = "",
    val name: String? = null,
    val dp: String? = null,
    @SerializedName("last_seen") val lastSeen: String? = null,
    val online: Boolean = false,
    @SerializedName("conversation_id") val conversationId: Long = 0,
    @SerializedName("last_message") val lastMessage: String? = null,
    @SerializedName("last_message_at") val lastMessageAt: String? = null,
    @SerializedName("last_message_sender_id") val lastMessageSenderId: String? = null,
    @SerializedName("unread_count") val unreadCount: Int = 0,
    val muted: Boolean = false,
    @SerializedName("muted_until") val mutedUntil: String? = null,
    val blocked: Boolean = false,
    val typing: Boolean = false
) {
    val displayName: String
        get() = if (!name.isNullOrBlank()) name else if (phone.isNotBlank()) phone else "User #$id"
}

data class ChatsResponse(
    val ok: Boolean = false,
    val chats: List<ChatListItem> = emptyList()
)

// ---- Messages ----
data class MediaAttachment(
    val id: String = "",
    val mime: String = "",
    @SerializedName("original_name") val originalName: String = "",
    val size: Long = 0,
    val url: String = "",
    @SerializedName("server_copy") val serverCopy: Boolean = false
)

data class ReplyTo(
    @SerializedName("sender_name") val senderName: String? = null,
    val body: String? = null
)

data class Reaction(
    @SerializedName("user_id") val userId: String = "",
    val emoji: String = "",
    val name: String? = null
)

data class ChatMessage(
    val id: String = System.currentTimeMillis().toString(),
    @SerializedName("sender_id", alternate = ["senderId", "from", "user_id"])
    val senderId: String = "",
    @SerializedName("receiver_id", alternate = ["receiverId", "to"])
    val receiverId: String = "",
    @SerializedName("sender_name") val senderName: String? = null,
    @SerializedName("body", alternate = ["text", "content"])
    val text: String = "",
    @SerializedName("created_at", alternate = ["createdAt"])
    val createdAt: String? = null,
    @SerializedName("edited_at") val editedAt: String? = null,
    @SerializedName("delivered_at", alternate = ["deliveredAt"])
    val deliveredAt: String? = null,
    @SerializedName("read_at", alternate = ["readAt"])
    val readAt: String? = null,
    @SerializedName("reply_to_id") val replyToId: Long? = null,
    @SerializedName("reply_sender_name") val replySenderName: String? = null,
    @SerializedName("reply_body") val replyBody: String? = null,
    @SerializedName("forwarded_from_id") val forwardedFromId: Long? = null,
    @SerializedName("pinned_at") val pinnedAt: String? = null,
    val media: MediaAttachment? = null,
    @SerializedName("media_url", alternate = ["mediaUrl"])
    val mediaUrl: String? = null,
    val reactions: List<Reaction> = emptyList(),
    val timestamp: Long = System.currentTimeMillis(),
    val isMine: Boolean = false
)

data class MessagesResponse(
    val ok: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    @SerializedName("has_more") val hasMore: Boolean = false
)

// ---- WebSocket ----
data class WsMessage(
    val type: String = "",
    val message: ChatMessage? = null,
    @SerializedName("message_id", alternate = ["messageId"])
    val messageId: String? = null,
    @SerializedName("receiver_id", alternate = ["receiverId", "to"])
    val receiverId: String? = null,
    @SerializedName("sender_id", alternate = ["senderId", "from", "user_id"])
    val senderId: String? = null,
    @SerializedName("body", alternate = ["text"])
    val text: String? = null,
    @SerializedName("delivered_at", alternate = ["deliveredAt"])
    val deliveredAt: String? = null,
    @SerializedName("read_at", alternate = ["readAt"])
    val readAt: String? = null,
    val online: Boolean? = null,
    @SerializedName("last_seen", alternate = ["lastSeen"])
    val lastSeen: String? = null,
    val chats: List<ChatListItem>? = null,
    val settings: UserSettings? = null,
    val error: String? = null
)

// ---- Settings ----
data class UserSettings(
    @SerializedName("user_id") val userId: Long = 0,
    val notifications: Boolean = true,
    @SerializedName("read_receipts") val readReceipts: Boolean = true,
    @SerializedName("last_seen_visibility") val lastSeenVisibility: String = "everyone",
    @SerializedName("dp_visibility") val dpVisibility: String = "everyone",
    val theme: String = "light",
    val wallpaper: String = "classic",
    @SerializedName("typing_indicator") val typingIndicator: Boolean = true,
    @SerializedName("enter_to_send") val enterToSend: Boolean = true,
    @SerializedName("compact_bubbles") val compactBubbles: Boolean = false,
    @SerializedName("glass_ui") val glassUi: Boolean = true,
    @SerializedName("glass_intensity") val glassIntensity: Int = 70,
    val animations: Boolean = true,
    @SerializedName("message_density") val messageDensity: String = "comfortable",
    @SerializedName("notification_preview") val notificationPreview: Boolean = true,
    @SerializedName("notification_volume") val notificationVolume: Int = 70,
    @SerializedName("notification_vibrate") val notificationVibrate: Boolean = true,
    @SerializedName("online_visibility") val onlineVisibility: String = "everyone",
    @SerializedName("status_visibility") val statusVisibility: String = "everyone"
)

data class SettingsResponse(
    val ok: Boolean = false,
    val settings: UserSettings? = null
)

data class SettingsUpdateRequest(
    val settings: Map<String, Any>
)

// ---- Status ----
data class StatusMedia(
    val id: String = "",
    val mime: String = "",
    @SerializedName("original_name") val originalName: String = "",
    val size: Long = 0,
    val url: String = ""
)

data class StatusItem(
    val id: Long = 0,
    @SerializedName("user_id") val userId: Long = 0,
    val name: String? = null,
    val dp: String? = null,
    val body: String = "",
    val media: StatusMedia? = null,
    @SerializedName("created_at") val createdAt: String = "",
    @SerializedName("expires_at") val expiresAt: String = "",
    val viewed: Boolean = false,
    @SerializedName("view_count") val viewCount: Int = 0,
    @SerializedName("like_count") val likeCount: Int = 0,
    val liked: Boolean = false,
    @SerializedName("has_unviewed") val hasUnviewed: Boolean = false,
    val viewers: List<StatusViewer> = emptyList()
)

data class StatusViewer(
    @SerializedName("user_id") val userId: Long = 0,
    val name: String? = null,
    val dp: String? = null,
    @SerializedName("viewed_at") val viewedAt: String = ""
)

data class StatusListResponse(
    val ok: Boolean = false,
    val statuses: List<StatusItem> = emptyList()
)

// ---- FCM Device Registration ----
data class DeviceRegisterRequest(
    val token: String,
    @SerializedName("device_id") val deviceId: String? = null
)

// ---- Profile ----
data class ProfileResponse(
    val ok: Boolean = false,
    val user: User? = null
)

data class MeResponse(
    val ok: Boolean = false,
    val user: User? = null
)

data class DpUploadResponse(
    val ok: Boolean = false,
    val dp: String? = null,
    val error: String? = null
)
