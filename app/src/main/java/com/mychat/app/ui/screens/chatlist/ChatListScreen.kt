package com.mychat.app.ui.screens.chatlist

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mychat.app.model.ChatListItem
import com.mychat.app.model.User
import com.mychat.app.model.UserSettings
import com.mychat.app.ui.components.UserAvatar
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(
    myUser: User?,
    isConnected: Boolean,
    chatList: List<ChatListItem>,
    settings: UserSettings,
    onSearchUsers: (String) -> Unit,
    searchResults: List<User>,
    onSelectChat: (ChatListItem) -> Unit,
    onSelectUser: (User) -> Unit,
    onOpenStatus: () -> Unit,
    onOpenSettings: () -> Unit,
    onLogout: () -> Unit
) {
    val accent = Color(0xFF0B8C72)
    val accent2 = Color(0xFF14B896)

    var searchQuery by remember { mutableStateOf("") }
    var searchOpen by remember { mutableStateOf(false) }
    var activeTab by remember { mutableStateOf(0) } // 0=Chats, 1=Status, 2=Communities

    val snackbarHostState = remember { SnackbarHostState() }
    var showCommunitiesSnackbar by remember { mutableStateOf(false) }

    if (showCommunitiesSnackbar) {
        LaunchedEffect(Unit) {
            snackbarHostState.showSnackbar("Communities coming soon! 🏘️")
            showCommunitiesSnackbar = false
        }
    }

    val tabLabels = listOf("💬 Chats", "🟢 Status", "🏘️ Communities")

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { searchOpen = true },
                containerColor = accent,
                contentColor = Color.White
            ) {
                Icon(Icons.Default.Edit, contentDescription = "New Chat")
            }
        },
        topBar = {
            Column(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surface)
            ) {
                // Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(72.dp)
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(11.dp)
                ) {
                    // Profile avatar
                    UserAvatar(
                        name = myUser?.displayName ?: "U",
                        dp = myUser?.dp,
                        size = 44.dp,
                        modifier = Modifier.clickable { onOpenSettings() }
                    )
                    // Title + status
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            "MyChat",
                            fontWeight = FontWeight(850),
                            fontSize = 20.sp,
                            letterSpacing = (-0.4).sp
                        )
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Box(
                                Modifier
                                    .size(8.dp)
                                    .clip(RoundedCornerShape(50))
                                    .background(if (isConnected) Color(0xFF10B981) else Color(0xFF98ABB5))
                            )
                            Text(
                                if (isConnected) "Connected" else "Connecting…",
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (isConnected) Color(0xFF0C8B63) else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    // Buttons
                    IconButton(onClick = { searchOpen = !searchOpen }) {
                        Icon(Icons.Default.Search, contentDescription = "Search")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                }

                // Search bar
                AnimatedVisibility(visible = searchOpen) {
                    Column {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = {
                                searchQuery = it
                                onSearchUsers(it)
                            },
                            placeholder = { Text("Search users by name or phone…", fontSize = 13.sp) },
                            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                            trailingIcon = if (searchQuery.isNotBlank()) {{
                                IconButton(onClick = { searchQuery = ""; onSearchUsers("") }) {
                                    Icon(Icons.Default.Close, contentDescription = "Clear")
                                }
                            }} else null,
                            singleLine = true,
                            shape = RoundedCornerShape(13.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = accent,
                                focusedContainerColor = MaterialTheme.colorScheme.surface,
                                unfocusedContainerColor = MaterialTheme.colorScheme.surface
                            )
                        )
                    }
                }

                // ScrollableTabRow
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                ScrollableTabRow(
                    selectedTabIndex = activeTab,
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = accent,
                    edgePadding = 8.dp
                ) {
                    tabLabels.forEachIndexed { i, label ->
                        Tab(
                            selected = activeTab == i,
                            onClick = {
                                activeTab = i
                                when (i) {
                                    1 -> onOpenStatus()
                                    2 -> showCommunitiesSnackbar = true
                                }
                            },
                            text = {
                                Text(
                                    label,
                                    fontSize = 13.sp,
                                    fontWeight = if (activeTab == i) FontWeight(750) else FontWeight.Normal
                                )
                            }
                        )
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background)
        ) {
            if (searchOpen && searchQuery.isNotBlank()) {
                // Show search results
                if (searchResults.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.SearchOff, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(.4f))
                            Spacer(Modifier.height(8.dp))
                            Text("No users found for \"$searchQuery\"", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 6.dp)) {
                        items(searchResults) { user ->
                            SearchUserRow(user = user, onClick = { onSelectUser(user) })
                        }
                    }
                }
            } else if (chatList.isEmpty()) {
                // Empty state
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("💬", fontSize = 56.sp)
                        Text("No conversations yet", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurface)
                        Text("Search for a user to start chatting", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(
                            onClick = { searchOpen = true },
                            shape = RoundedCornerShape(13.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = accent)
                        ) {
                            Icon(Icons.Default.Search, null, Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Find Someone")
                        }
                    }
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 6.dp)) {
                    items(chatList, key = { it.conversationId }) { chat ->
                        ChatRow(chat = chat, myId = myUser?.id ?: "", onClick = { onSelectChat(chat) })
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatRow(chat: ChatListItem, myId: String, onClick: () -> Unit) {
    val accent = Color(0xFF0B8C72)
    val accent2 = Color(0xFF14B896)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick)
            .clip(RoundedCornerShape(16.dp))
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp)
    ) {
        UserAvatar(
            name = chat.displayName,
            dp = chat.dp,
            isOnline = chat.online,
            size = 48.dp
        )

        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    chat.displayName,
                    fontWeight = FontWeight(750),
                    fontSize = 14.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                // Time
                if (!chat.lastMessageAt.isNullOrBlank()) {
                    Text(
                        formatChatTime(chat.lastMessageAt),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Row(
                modifier = Modifier.padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp)
            ) {
                // Tick for my messages
                if (chat.lastMessageSenderId == myId && !chat.lastMessage.isNullOrBlank()) {
                    Text("✓✓", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = accent, letterSpacing = (-1).sp)
                }
                Text(
                    when {
                        chat.typing -> "typing…"
                        chat.muted -> "🔇 ${chat.lastMessage ?: ""}"
                        !chat.lastMessage.isNullOrBlank() -> chat.lastMessage
                        else -> "No messages yet"
                    },
                    fontSize = 12.5.sp,
                    color = if (chat.typing) accent else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                // Unread badge
                if (chat.unreadCount > 0) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(Brush.linearGradient(listOf(accent2, accent)))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            if (chat.unreadCount > 99) "99+" else chat.unreadCount.toString(),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.ExtraBold,
                            color = Color.White
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun SearchUserRow(user: User, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .clip(RoundedCornerShape(16.dp))
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp)
    ) {
        UserAvatar(name = user.displayName, dp = user.dp, size = 46.dp)
        Column(modifier = Modifier.weight(1f)) {
            Text(user.displayName, fontWeight = FontWeight.Bold, fontSize = 14.5.sp)
            if (!user.phone.isNullOrBlank()) {
                Text(user.phone, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(.5f))
    }
}

private fun formatChatTime(iso: String): String {
    return try {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
        val date = sdf.parse(iso.substringBefore(".")) ?: return ""
        val nowMs = System.currentTimeMillis()
        val diffMs = nowMs - date.time
        val diffDays = TimeUnit.MILLISECONDS.toDays(diffMs)
        when {
            diffDays == 0L -> SimpleDateFormat("h:mm a", Locale.getDefault()).format(date)
            diffDays == 1L -> "Yesterday"
            diffDays < 7L -> SimpleDateFormat("EEE", Locale.getDefault()).format(date)
            else -> SimpleDateFormat("dd MMM", Locale.getDefault()).format(date)
        }
    } catch (_: Exception) { "" }
}
