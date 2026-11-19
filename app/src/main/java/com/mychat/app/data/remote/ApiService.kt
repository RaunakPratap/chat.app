package com.mychat.app.data.remote

import com.mychat.app.model.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    @GET("healthz")
    suspend fun getHealth(): Response<HealthResponse>

    @POST("api/login")
    suspend fun login(@Body request: AuthRequest): Response<AuthResponse>

    @POST("api/register")
    suspend fun register(@Body request: AuthRequest): Response<AuthResponse>

    @POST("api/forgot-device")
    suspend fun forgotDevice(@Body request: ForgotDeviceRequest): Response<GenericResponse>

    @GET("api/me")
    suspend fun getMe(@Header("Authorization") token: String): Response<MeResponse>

    @GET("api/search")
    suspend fun searchUsers(
        @Query("q") query: String,
        @Header("Authorization") token: String
    ): Response<UserSearchResponse>

    @POST("api/logout")
    suspend fun logout(@Header("Authorization") token: String): Response<GenericResponse>

    // Chat list (all conversations with last message + unread count)
    @GET("api/chats")
    suspend fun getChats(@Header("Authorization") token: String): Response<ChatsResponse>

    // Message history for a conversation
    @GET("api/messages")
    suspend fun getMessages(
        @Query("user_id") userId: String,
        @Query("before") before: Long? = null,
        @Query("limit") limit: Int = 40,
        @Header("Authorization") token: String
    ): Response<MessagesResponse>

    // Settings
    @GET("api/settings")
    suspend fun getSettings(@Header("Authorization") token: String): Response<SettingsResponse>

    @POST("api/settings")
    suspend fun updateSettings(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
        @Header("Authorization") token: String
    ): Response<SettingsResponse>

    // Status
    @GET("api/status")
    suspend fun getStatuses(@Header("Authorization") token: String): Response<StatusListResponse>

    @POST("api/status")
    suspend fun postStatus(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
        @Header("Authorization") token: String
    ): Response<GenericResponse>

    // Profile
    @GET("api/profile")
    suspend fun getProfile(
        @Query("user_id") userId: String,
        @Header("Authorization") token: String
    ): Response<ProfileResponse>

    // DP Upload
    @Multipart
    @POST("api/dp-upload")
    suspend fun uploadDp(
        @Part file: MultipartBody.Part,
        @Header("Authorization") token: String
    ): Response<DpUploadResponse>

    // FCM device token registration
    @POST("api/device/register")
    suspend fun registerDevice(
        @Body request: DeviceRegisterRequest,
        @Header("Authorization") token: String
    ): Response<GenericResponse>

    // Media upload
    @Multipart
    @POST("api/media/upload")
    suspend fun uploadMedia(
        @Part file: MultipartBody.Part,
        @Part("to") to: RequestBody,
        @Header("Authorization") token: String
    ): Response<MediaUploadResponse>

    // Reactions
    @POST("api/reaction")
    suspend fun sendReaction(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
        @Header("Authorization") token: String
    ): Response<GenericResponse>

    // Block / Unblock
    @POST("api/block")
    suspend fun blockUser(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
        @Header("Authorization") token: String
    ): Response<GenericResponse>

    @POST("api/unblock")
    suspend fun unblockUser(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
        @Header("Authorization") token: String
    ): Response<GenericResponse>
}

data class MediaUploadResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val url: String? = null,
    val error: String? = null
)

data class GitHubContentResponse(
    val name: String? = null,
    val content: String? = null,
    val encoding: String? = null
)

interface GitHubBackendUrlService {
    @GET
    suspend fun fetchBackendUrl(@Url url: String): String

    @GET
    suspend fun fetchBackendUrlApi(@Url url: String): Response<GitHubContentResponse>
}
