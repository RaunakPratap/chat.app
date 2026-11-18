package com.mychat.app.ui.navigation

sealed class Screen(val route: String) {
    object Login : Screen("login")
    object Register : Screen("register")
    object ForgotPassword : Screen("forgot_password")
    object ChatList : Screen("chat_list")
    object Status : Screen("status")
    object Settings : Screen("settings")
    object GroupChat : Screen("group_chat")
    object StarredMessages : Screen("starred_messages")
    object AppLock : Screen("app_lock")
    object ChatDetail : Screen("chat_detail/{userId}/{username}/{name}") {
        fun createRoute(userId: String, username: String, name: String): String {
            val encodedName = java.net.URLEncoder.encode(name, "UTF-8")
            val encodedUsername = java.net.URLEncoder.encode(username, "UTF-8")
            return "chat_detail/$userId/$encodedUsername/$encodedName"
        }
    }
}
