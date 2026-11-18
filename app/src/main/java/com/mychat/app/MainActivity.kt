package com.mychat.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.google.firebase.messaging.FirebaseMessaging
import com.mychat.app.data.local.TokenManager
import com.mychat.app.data.repository.ChatRepository
import com.mychat.app.model.User
import com.mychat.app.util.ShakeDetector
import com.mychat.app.ui.navigation.Screen
import com.mychat.app.ui.screens.auth.ForgotPasswordScreen
import com.mychat.app.ui.screens.auth.LoginScreen
import com.mychat.app.ui.screens.auth.RegisterScreen
import com.mychat.app.ui.screens.chatdetail.ChatDetailScreen
import com.mychat.app.ui.screens.chatlist.ChatListScreen
import com.mychat.app.ui.screens.settings.SettingsScreen
import com.mychat.app.ui.screens.status.StatusScreen
import com.mychat.app.ui.theme.MyChatTheme
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import java.net.URLDecoder

class MainActivity : ComponentActivity() {

    private lateinit var tokenManager: TokenManager
    private lateinit var repository: ChatRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        tokenManager = TokenManager(applicationContext)
        repository = ChatRepository(tokenManager)

        // Apply screenshot & screen recording protection on native Android by default
        setScreenshotProtection(true)

        setContent {
            val settingsState by repository.settingsState.collectAsState()
            MyChatTheme(themeOverride = settingsState.theme) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    AppContent(
                        tokenManager = tokenManager,
                        repository = repository,
                        onToggleScreenshotProtection = { enabled ->
                            setScreenshotProtection(enabled)
                        }
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        repository.webSocketManager.sendVisibility(true)
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            repository.checkAndApplyBackendUrlUpdate()
        }
    }

    override fun onPause() {
        super.onPause()
        repository.webSocketManager.sendVisibility(false)
    }

    fun setScreenshotProtection(enabled: Boolean) {
        if (enabled) {
            window.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
            )
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
}

// Routes where the bottom navigation bar is visible
private val bottomNavRoutes = setOf(
    Screen.ChatList.route,
    Screen.Status.route,
    Screen.Settings.route
)

@Composable
private fun AppContent(
    tokenManager: TokenManager,
    repository: ChatRepository,
    onToggleScreenshotProtection: (Boolean) -> Unit
) {
    val navController = rememberNavController()
    val coroutineScope = rememberCoroutineScope()

    var isLoading by remember { mutableStateOf(true) }
    var isLoggedIn by remember { mutableStateOf(false) }
    var myUserId by remember { mutableStateOf("") }
    var myPhone by remember { mutableStateOf("") }

    var authError by remember { mutableStateOf<String?>(null) }
    var forgotSuccess by remember { mutableStateOf<String?>(null) }
    var isAuthLoading by remember { mutableStateOf(false) }

    var searchResults by remember { mutableStateOf<List<User>>(emptyList()) }
    var screenshotBlock by remember { mutableStateOf(true) }

    val myUser by repository.myUser.collectAsState()
    val chatList by repository.chatListState.collectAsState()
    val messagesState by repository.messagesState.collectAsState()
    val presenceState by repository.presenceState.collectAsState()
    val typingState by repository.typingState.collectAsState()
    val settingsState by repository.settingsState.collectAsState()
    val statusList by repository.statusList.collectAsState()
    val isConnected by repository.webSocketManager.isConnected.collectAsState()

    // Shake to Delete (Emergency Anti-snatch Wipe) Sensor
    val context = LocalContext.current
    val shakeEnabled by tokenManager.shakeToDeleteFlow.collectAsState(initial = true)
    val shakeMode by tokenManager.shakeDeleteModeFlow.collectAsState(initial = "current")
    val shakeSensitivity by tokenManager.shakeSensitivityFlow.collectAsState(initial = "medium")
    val shakeSelectedUsers by tokenManager.shakeSelectedUsersFlow.collectAsState(initial = emptySet())

    DisposableEffect(shakeEnabled, shakeMode, shakeSensitivity, shakeSelectedUsers) {
        if (!shakeEnabled) return@DisposableEffect onDispose {}

        val detector = ShakeDetector(context) {
            coroutineScope.launch {
                val currentBackStack = navController.currentBackStackEntry
                val currentDest = currentBackStack?.destination?.route
                val currentChatUserId = if (currentDest?.startsWith("chat_detail") == true) {
                    currentBackStack.arguments?.getString("userId")
                } else null

                val count = repository.panicWipeChats(shakeMode, currentChatUserId, shakeSelectedUsers)
                if (count > 0 && currentDest?.startsWith("chat_detail") == true) {
                    navController.popBackStack(Screen.ChatList.route, inclusive = false)
                }
            }
        }
        detector.setSensitivity(shakeSensitivity)
        detector.start()
        onDispose {
            detector.stop()
        }
    }

    // Current route for bottom nav visibility
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val showBottomBar = currentRoute in bottomNavRoutes

    // Startup: resolve URL from GitHub, load session and fetch chats
    LaunchedEffect(Unit) {
        val baseUrl = repository.resolveBaseUrl()
        val token = tokenManager.tokenFlow.firstOrNull()
        val uId = tokenManager.userIdFlow.firstOrNull()
        val phone = tokenManager.usernameFlow.firstOrNull()
        val sb = tokenManager.screenshotBlockFlow.firstOrNull() ?: true
        screenshotBlock = sb
        onToggleScreenshotProtection(sb)

        if (!token.isNullOrBlank() && !uId.isNullOrBlank()) {
            myUserId = uId
            myPhone = phone ?: ""
            isLoggedIn = true

            repository.webSocketManager.connect(baseUrl, token)
            repository.fetchMe()
            repository.fetchChats()
            repository.fetchSettings()

            // Register FCM token
            try {
                FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                    if (task.isSuccessful && !task.result.isNullOrBlank()) {
                        coroutineScope.launch {
                            repository.registerFcmToken(task.result)
                        }
                    }
                }
            } catch (_: Exception) {}
        }
        isLoading = false
    }

    if (isLoading) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
        }
        return
    }

    val startDestination = if (isLoggedIn) Screen.ChatList.route else Screen.Login.route

    val accentColor = Color(0xFF0B8C72)

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars),
        bottomBar = {
            if (showBottomBar) {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    NavigationBarItem(
                        selected = currentRoute == Screen.ChatList.route,
                        onClick = {
                            navController.navigate(Screen.ChatList.route) {
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(Icons.Default.Chat, contentDescription = null) },
                        label = { Text("Chats") },
                        colors = NavigationBarItemDefaults.colors(
                            indicatorColor = accentColor.copy(alpha = 0.2f),
                            selectedIconColor = accentColor,
                            selectedTextColor = accentColor
                        )
                    )
                    NavigationBarItem(
                        selected = currentRoute == Screen.Status.route,
                        onClick = {
                            coroutineScope.launch { repository.fetchStatuses() }
                            navController.navigate(Screen.Status.route) {
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(Icons.Default.Circle, contentDescription = null) },
                        label = { Text("Status") },
                        colors = NavigationBarItemDefaults.colors(
                            indicatorColor = accentColor.copy(alpha = 0.2f),
                            selectedIconColor = accentColor,
                            selectedTextColor = accentColor
                        )
                    )
                    NavigationBarItem(
                        selected = currentRoute == Screen.Settings.route,
                        onClick = {
                            coroutineScope.launch { repository.fetchSettings() }
                            navController.navigate(Screen.Settings.route) {
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                        label = { Text("Settings") },
                        colors = NavigationBarItemDefaults.colors(
                            indicatorColor = accentColor.copy(alpha = 0.2f),
                            selectedIconColor = accentColor,
                            selectedTextColor = accentColor
                        )
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Login.route) {
                LoginScreen(
                    onLoginClick = { phone, password ->
                        isAuthLoading = true
                        authError = null
                        coroutineScope.launch {
                            val res = repository.login(phone, password)
                            isAuthLoading = false
                            if (res.ok && res.user != null) {
                                myUserId = res.user.id
                                myPhone = res.user.phone
                                isLoggedIn = true
                                repository.fetchChats()
                                repository.fetchSettings()

                                // Register FCM token
                                try {
                                    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                                        if (task.isSuccessful && !task.result.isNullOrBlank()) {
                                            coroutineScope.launch {
                                                repository.registerFcmToken(task.result)
                                            }
                                        }
                                    }
                                } catch (_: Exception) {}

                                navController.navigate(Screen.ChatList.route) {
                                    popUpTo(Screen.Login.route) { inclusive = true }
                                }
                            } else {
                                authError = res.error ?: "Login failed. Check server status or credentials."
                            }
                        }
                    },
                    onNavigateToRegister = {
                        authError = null
                        navController.navigate(Screen.Register.route)
                    },
                    onNavigateToForgotPassword = {
                        authError = null
                        forgotSuccess = null
                        navController.navigate(Screen.ForgotPassword.route)
                    },
                    isLoading = isAuthLoading,
                    errorMessage = authError
                )
            }

            composable(Screen.Register.route) {
                RegisterScreen(
                    onRegisterClick = { phone, password, name ->
                        isAuthLoading = true
                        authError = null
                        coroutineScope.launch {
                            val res = repository.register(phone, password, name)
                            isAuthLoading = false
                            if (res.ok && res.user != null) {
                                myUserId = res.user.id
                                myPhone = res.user.phone
                                isLoggedIn = true
                                repository.fetchChats()
                                repository.fetchSettings()

                                navController.navigate(Screen.ChatList.route) {
                                    popUpTo(Screen.Register.route) { inclusive = true }
                                }
                            } else {
                                authError = res.error ?: "Registration failed."
                            }
                        }
                    },
                    onNavigateToLogin = {
                        authError = null
                        navController.navigate(Screen.Login.route)
                    },
                    isLoading = isAuthLoading,
                    errorMessage = authError
                )
            }

            composable(Screen.ForgotPassword.route) {
                ForgotPasswordScreen(
                    onResetPasswordClick = { phone, token, newPass ->
                        isAuthLoading = true
                        authError = null
                        forgotSuccess = null
                        coroutineScope.launch {
                            val res = repository.forgotDevice(phone, token, newPass)
                            isAuthLoading = false
                            if (res.ok) {
                                forgotSuccess = "Password reset successfully! Please sign in."
                            } else {
                                authError = res.error ?: "Password recovery failed."
                            }
                        }
                    },
                    onNavigateToLogin = {
                        authError = null
                        forgotSuccess = null
                        navController.navigate(Screen.Login.route) {
                            popUpTo(Screen.ForgotPassword.route) { inclusive = true }
                        }
                    },
                    isLoading = isAuthLoading,
                    errorMessage = authError,
                    successMessage = forgotSuccess
                )
            }

            composable(Screen.ChatList.route) {
                ChatListScreen(
                    myUser = myUser ?: User(id = myUserId, phone = myPhone),
                    isConnected = isConnected,
                    chatList = chatList,
                    settings = settingsState,
                    onSearchUsers = { query ->
                        coroutineScope.launch {
                            searchResults = if (query.isNotBlank()) {
                                repository.searchUsers(query)
                            } else emptyList()
                        }
                    },
                    searchResults = searchResults,
                    onSelectChat = { chat ->
                        val route = Screen.ChatDetail.createRoute(
                            chat.id,
                            chat.phone,
                            chat.displayName
                        )
                        navController.navigate(route)
                    },
                    onSelectUser = { user ->
                        val route = Screen.ChatDetail.createRoute(
                            user.id,
                            user.phone,
                            user.displayName
                        )
                        navController.navigate(route)
                    },
                    onOpenStatus = {
                        coroutineScope.launch { repository.fetchStatuses() }
                        navController.navigate(Screen.Status.route)
                    },
                    onOpenSettings = {
                        coroutineScope.launch { repository.fetchSettings() }
                        navController.navigate(Screen.Settings.route)
                    },
                    onLogout = {
                        coroutineScope.launch {
                            repository.logout()
                            isLoggedIn = false
                            navController.navigate(Screen.Login.route) {
                                popUpTo(Screen.ChatList.route) { inclusive = true }
                            }
                        }
                    }
                )
            }

            composable(Screen.Status.route) {
                StatusScreen(
                    myUser = myUser ?: User(id = myUserId, phone = myPhone),
                    statuses = statusList,
                    onBack = { navController.popBackStack() },
                    onPostStatus = { text ->
                        coroutineScope.launch {
                            repository.postStatus(text)
                            repository.fetchStatuses()
                        }
                    },
                    onRefresh = {
                        coroutineScope.launch { repository.fetchStatuses() }
                    },
                    onLikeStatus = {}
                )
            }

            composable(Screen.Settings.route) {
                SettingsScreen(
                    myUser = myUser ?: User(id = myUserId, phone = myPhone),
                    settings = settingsState,
                    screenshotBlockEnabled = screenshotBlock,
                    shakeToDeleteEnabled = shakeEnabled,
                    shakeDeleteMode = shakeMode,
                    shakeSensitivity = shakeSensitivity,
                    onUpdateShakeSettings = { enabled, mode, sens ->
                        coroutineScope.launch {
                            tokenManager.saveShakeSettings(enabled, mode, sens, shakeSelectedUsers)
                        }
                    },
                    onToggleScreenshotBlock = { enabled ->
                        screenshotBlock = enabled
                        onToggleScreenshotProtection(enabled)
                        coroutineScope.launch {
                            tokenManager.saveScreenshotBlock(enabled)
                        }
                    },
                    onUpdateSetting = { key, value ->
                        coroutineScope.launch {
                            repository.updateSettings(key, value)
                        }
                    },
                    onUploadDp = { bytes, fileName ->
                        coroutineScope.launch {
                            repository.uploadDp(bytes, fileName)
                            repository.fetchMe()
                            repository.fetchChats()
                        }
                    },
                    onBack = { navController.popBackStack() },
                    onLogout = {
                        coroutineScope.launch {
                            repository.logout()
                            isLoggedIn = false
                            navController.navigate(Screen.Login.route) {
                                popUpTo(Screen.ChatList.route) { inclusive = true }
                            }
                        }
                    }
                )
            }

            composable(
                route = Screen.ChatDetail.route,
                arguments = listOf(
                    navArgument("userId") { type = NavType.StringType },
                    navArgument("username") { type = NavType.StringType },
                    navArgument("name") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val uId = backStackEntry.arguments?.getString("userId") ?: ""
                val rawPhone = backStackEntry.arguments?.getString("username") ?: ""
                val rawName = backStackEntry.arguments?.getString("name") ?: ""

                val uPhone = try { URLDecoder.decode(rawPhone, "UTF-8") } catch (_: Exception) { rawPhone }
                val name = try { URLDecoder.decode(rawName, "UTF-8") } catch (_: Exception) { rawName }

                var hasMore by remember(uId) { mutableStateOf(false) }

                LaunchedEffect(uId) {
                    if (uId.isNotBlank()) {
                        repository.markChatAsRead(uId)
                        val msgs = repository.fetchMessages(uId)
                        hasMore = msgs.size >= 40
                    }
                }

                val targetUser = User(id = uId, phone = uPhone, name = name)
                val chatMessages = messagesState[uId] ?: emptyList()
                val presenceEvt = presenceState[uId]
                val isUserTyping = typingState[uId] ?: false

                // Instant real-time read receipt: whenever any new message arrives while on this screen
                LaunchedEffect(chatMessages.size, chatMessages.lastOrNull()?.id) {
                    if (uId.isNotBlank() && chatMessages.isNotEmpty()) {
                        val last = chatMessages.last()
                        if (!last.isMine && last.readAt.isNullOrBlank()) {
                            repository.markChatAsRead(uId)
                        }
                    }
                }

                ChatDetailScreen(
                    targetUser = targetUser,
                    messages = chatMessages,
                    isOnline = presenceEvt?.isOnline ?: false,
                    lastSeen = presenceEvt?.lastSeen,
                    isTyping = isUserTyping,
                    myId = myUserId,
                    hasMoreHistory = hasMore,
                    onLoadMore = {
                        val oldest = chatMessages.firstOrNull()?.id?.toLongOrNull()
                        if (oldest != null) {
                            coroutineScope.launch {
                                repository.fetchMessages(uId, before = oldest)
                            }
                        }
                    },
                    onSendMessage = { text, replyToId ->
                        repository.sendMessage(uId, text, myUserId, replyToId)
                    },
                    onTyping = { isTyping ->
                        repository.sendTyping(uId, isTyping)
                    },
                    onBackClick = {
                        navController.popBackStack()
                    },
                    onEditMessage = { msgId, newText ->
                        coroutineScope.launch { repository.editMessage(uId, msgId, newText) }
                    },
                    onDeleteMessage = { msgId, deleteForAll ->
                        coroutineScope.launch { repository.deleteMessage(uId, msgId, deleteForAll) }
                    },
                    onReactToMessage = { msgId, emoji ->
                        coroutineScope.launch { repository.reactToMessage(msgId, emoji) }
                    }
                )
            }
        }
    }
}
