package com.mychat.app.ui.screens.chatdetail

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.mychat.app.model.ChatMessage
import com.mychat.app.model.User
import com.mychat.app.ui.components.TickMarks
import com.mychat.app.ui.components.UserAvatar
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(
    targetUser: User,
    messages: List<ChatMessage>,
    isOnline: Boolean,
    lastSeen: String?,
    isTyping: Boolean,
    myId: String,
    hasMoreHistory: Boolean = false,
    onLoadMore: () -> Unit = {},
    onSendMessage: (String, Long?) -> Unit,
    onTyping: (Boolean) -> Unit,
    onBackClick: () -> Unit,
    onEditMessage: (messageId: String, newText: String) -> Unit = { _, _ -> },
    onDeleteMessage: (messageId: String, deleteForAll: Boolean) -> Unit = { _, _ -> },
    onReactToMessage: (messageId: String, emoji: String) -> Unit = { _, _ -> }
) {
    val accent = Color(0xFF0B8C72)
    val accent2 = Color(0xFF14B896)
    val context = LocalContext.current

    var textInput by remember { mutableStateOf("") }
    var replyTarget by remember { mutableStateOf<ChatMessage?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    // ── In-Chat Search State ──────────────────────────────────────────────────
    var searchMode by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var searchIndex by remember { mutableStateOf(0) }

    val filteredIndices: List<Int> = remember(messages, searchQuery) {
        if (searchQuery.isBlank()) emptyList()
        else messages.mapIndexedNotNull { i, msg ->
            if (msg.text.contains(searchQuery, ignoreCase = true)) i else null
        }
    }
    val displayedMessages: List<ChatMessage> = remember(messages, searchQuery) {
        if (searchQuery.isBlank()) messages
        else messages.filter { it.text.contains(searchQuery, ignoreCase = true) }
    }

    // ── Long-Press Bottom Sheet State ─────────────────────────────────────────
    var longPressedMessage by remember { mutableStateOf<ChatMessage?>(null) }
    var showBottomSheet by remember { mutableStateOf(false) }
    var showDeleteSubMenu by remember { mutableStateOf(false) }
    var showEmojiPicker by remember { mutableStateOf(false) }
    var showEditDialog by remember { mutableStateOf(false) }
    var editText by remember { mutableStateOf("") }
    val bottomSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // ── Pinned message ────────────────────────────────────────────────────────
    val pinnedMessage by remember(messages) {
        derivedStateOf { messages.firstOrNull { !it.pinnedAt.isNullOrBlank() } }
    }
    var pinnedDismissed by remember { mutableStateOf(false) }

    // Scroll to bottom when new message arrives
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    // Reset search index when results change
    LaunchedEffect(filteredIndices.size) { searchIndex = 0 }

    // Typing debounce
    LaunchedEffect(textInput) {
        onTyping(textInput.isNotBlank())
    }

    val subtitleText = when {
        isTyping -> "typing…"
        isOnline -> "Online"
        !lastSeen.isNullOrBlank() -> formatLastSeen(lastSeen)
        else -> targetUser.phone
    }

    // ── Long-Press Bottom Sheet ───────────────────────────────────────────────
    if (showBottomSheet && longPressedMessage != null) {
        val msg = longPressedMessage!!
        val isMineMsg = msg.senderId == myId || msg.isMine
        ModalBottomSheet(
            onDismissRequest = {
                showBottomSheet = false
                showDeleteSubMenu = false
                showEmojiPicker = false
                longPressedMessage = null
            },
            sheetState = bottomSheetState
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 24.dp)
            ) {
                // ── Emoji Picker ─────────────────────────────────────────────
                AnimatedVisibility(visible = showEmojiPicker) {
                    Column {
                        Text(
                            "React",
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)
                        )
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            listOf("👍", "❤️", "😂", "😮", "😢", "😡", "🙏", "🔥").forEach { emoji ->
                                TextButton(
                                    onClick = {
                                        onReactToMessage(msg.id, emoji)
                                        showBottomSheet = false
                                        showEmojiPicker = false
                                        longPressedMessage = null
                                    }
                                ) {
                                    Text(emoji, fontSize = 24.sp)
                                }
                            }
                        }
                        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                    }
                }

                // ── Delete sub-menu ──────────────────────────────────────────
                AnimatedVisibility(visible = showDeleteSubMenu) {
                    Column {
                        Text(
                            "Delete message",
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)
                        )
                        ListItem(
                            headlineContent = { Text("Delete for Me") },
                            leadingContent = { Text("🗑️", fontSize = 18.sp) },
                            modifier = Modifier.clickable {
                                onDeleteMessage(msg.id, false)
                                showBottomSheet = false
                                showDeleteSubMenu = false
                                longPressedMessage = null
                            }
                        )
                        if (isMineMsg) {
                            ListItem(
                                headlineContent = { Text("Delete for Everyone") },
                                leadingContent = { Text("🗑️", fontSize = 18.sp) },
                                modifier = Modifier.clickable {
                                    onDeleteMessage(msg.id, true)
                                    showBottomSheet = false
                                    showDeleteSubMenu = false
                                    longPressedMessage = null
                                }
                            )
                        }
                        ListItem(
                            headlineContent = { Text("Cancel") },
                            leadingContent = { Icon(Icons.Default.Close, null) },
                            modifier = Modifier.clickable { showDeleteSubMenu = false }
                        )
                    }
                }

                // ── Main menu ────────────────────────────────────────────────
                if (!showDeleteSubMenu && !showEmojiPicker) {
                    // Message preview
                    Text(
                        msg.text.take(80),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)
                    )
                    HorizontalDivider()

                    // 📋 Copy
                    ListItem(
                        headlineContent = { Text("Copy") },
                        leadingContent = { Text("📋", fontSize = 18.sp) },
                        modifier = Modifier.clickable {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("message", msg.text))
                            showBottomSheet = false
                            longPressedMessage = null
                        }
                    )
                    // ↩️ Reply
                    ListItem(
                        headlineContent = { Text("Reply") },
                        leadingContent = { Text("↩️", fontSize = 18.sp) },
                        modifier = Modifier.clickable {
                            replyTarget = msg
                            showBottomSheet = false
                            longPressedMessage = null
                        }
                    )
                    // ✏️ Edit (mine only)
                    if (isMineMsg) {
                        ListItem(
                            headlineContent = { Text("Edit") },
                            leadingContent = { Text("✏️", fontSize = 18.sp) },
                            modifier = Modifier.clickable {
                                editText = msg.text
                                showEditDialog = true
                                showBottomSheet = false
                            }
                        )
                    }
                    // 🗑️ Delete
                    ListItem(
                        headlineContent = { Text("Delete") },
                        leadingContent = { Text("🗑️", fontSize = 18.sp) },
                        modifier = Modifier.clickable { showDeleteSubMenu = true }
                    )
                    // 😊 React
                    ListItem(
                        headlineContent = { Text("React") },
                        leadingContent = { Text("😊", fontSize = 18.sp) },
                        modifier = Modifier.clickable { showEmojiPicker = true }
                    )
                    // 📤 Forward
                    ListItem(
                        headlineContent = { Text("Forward") },
                        leadingContent = { Text("📤", fontSize = 18.sp) },
                        modifier = Modifier.clickable {
                            showBottomSheet = false
                            longPressedMessage = null
                            scope.launch { snackbarHostState.showSnackbar("Forward: Coming soon") }
                        }
                    )
                }
            }
        }
    }

    // ── Edit Dialog ───────────────────────────────────────────────────────────
    if (showEditDialog && longPressedMessage != null) {
        val msgId = longPressedMessage!!.id
        AlertDialog(
            onDismissRequest = { showEditDialog = false; longPressedMessage = null },
            title = { Text("Edit Message") },
            text = {
                OutlinedTextField(
                    value = editText,
                    onValueChange = { editText = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 6,
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent)
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    if (editText.isNotBlank()) onEditMessage(msgId, editText.trim())
                    showEditDialog = false
                    longPressedMessage = null
                }) { Text("Save", color = accent) }
            },
            dismissButton = {
                TextButton(onClick = { showEditDialog = false; longPressedMessage = null }) { Text("Cancel") }
            }
        )
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            Column(
                Modifier
                    .background(MaterialTheme.colorScheme.surface)
                    .fillMaxWidth()
            ) {
                if (searchMode) {
                    // ── Search bar ────────────────────────────────────────────
                    Row(
                        modifier = Modifier
                            .height(72.dp)
                            .padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        IconButton(onClick = {
                            searchMode = false
                            searchQuery = ""
                        }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close Search")
                        }
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            placeholder = { Text("Search messages…", fontSize = 14.sp) },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            shape = RoundedCornerShape(22.dp),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = {}),
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent)
                        )
                        if (filteredIndices.isNotEmpty()) {
                            Text(
                                "${searchIndex + 1} of ${filteredIndices.size}",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 4.dp)
                            )
                            IconButton(onClick = {
                                if (filteredIndices.isNotEmpty()) {
                                    searchIndex = (searchIndex - 1 + filteredIndices.size) % filteredIndices.size
                                    scope.launch { listState.animateScrollToItem(filteredIndices[searchIndex]) }
                                }
                            }) {
                                Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Previous")
                            }
                            IconButton(onClick = {
                                if (filteredIndices.isNotEmpty()) {
                                    searchIndex = (searchIndex + 1) % filteredIndices.size
                                    scope.launch { listState.animateScrollToItem(filteredIndices[searchIndex]) }
                                }
                            }) {
                                Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Next")
                            }
                        }
                    }
                } else {
                    // ── Normal TopBar ─────────────────────────────────────────
                    Row(
                        modifier = Modifier
                            .height(72.dp)
                            .padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(0.dp)
                    ) {
                        IconButton(onClick = onBackClick) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                        UserAvatar(name = targetUser.displayName, dp = targetUser.dp, isOnline = isOnline, size = 44.dp)
                        Spacer(Modifier.width(10.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                targetUser.displayName,
                                fontWeight = FontWeight(800),
                                fontSize = 15.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                subtitleText,
                                fontSize = 12.sp,
                                color = if (isTyping || isOnline) accent else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        IconButton(onClick = { searchMode = true }) {
                            Icon(Icons.Default.Search, contentDescription = "Search")
                        }
                        IconButton(onClick = {}) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                    }
                }

                // ── Pinned Message Banner ─────────────────────────────────────
                if (pinnedMessage != null && !pinnedDismissed) {
                    val pm = pinnedMessage!!
                    Surface(
                        color = accent.copy(alpha = 0.08f),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                val pmIndex = messages.indexOf(pm)
                                if (pmIndex >= 0) scope.launch { listState.animateScrollToItem(pmIndex) }
                            }
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("📌", fontSize = 14.sp)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                pm.text.take(80),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            IconButton(
                                onClick = { pinnedDismissed = true },
                                modifier = Modifier.size(28.dp)
                            ) {
                                Icon(Icons.Default.Close, null, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }

                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background)
                .imePadding()
        ) {
            // Message list
            val listMessages = if (searchQuery.isBlank()) messages else displayedMessages
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                // Load more button
                if (hasMoreHistory) {
                    item {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            OutlinedButton(
                                onClick = onLoadMore,
                                shape = RoundedCornerShape(999.dp),
                                modifier = Modifier.padding(vertical = 8.dp)
                            ) {
                                Text("Load older messages", fontSize = 12.sp)
                            }
                        }
                    }
                }

                items(listMessages, key = { it.id }) { msg ->
                    MessageBubble(
                        message = msg,
                        myId = myId,
                        onLongPress = {
                            longPressedMessage = msg
                            showBottomSheet = true
                            showDeleteSubMenu = false
                            showEmojiPicker = false
                        },
                        onReply = { replyTarget = it }
                    )
                }
            }

            // Composer
            Surface(
                tonalElevation = 2.dp,
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    // Reply preview
                    if (replyTarget != null) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(accent.copy(alpha = 0.1f))
                                .padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Box(
                                Modifier
                                    .width(3.dp)
                                    .height(32.dp)
                                    .background(accent, RoundedCornerShape(2.dp))
                            )
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    if (replyTarget!!.isMine) "You" else replyTarget!!.senderName ?: targetUser.displayName,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 11.sp,
                                    color = accent
                                )
                                Text(
                                    replyTarget!!.text.take(80),
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            IconButton(onClick = { replyTarget = null }, Modifier.size(32.dp)) {
                                Icon(Icons.Default.Close, null, Modifier.size(18.dp))
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                    }

                    // Input row
                    Row(
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedTextField(
                            value = textInput,
                            onValueChange = { textInput = it },
                            placeholder = { Text("Message…", fontSize = 14.sp) },
                            modifier = Modifier.weight(1f),
                            maxLines = 5,
                            shape = RoundedCornerShape(22.dp),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = accent,
                                focusedContainerColor = MaterialTheme.colorScheme.surface,
                                unfocusedContainerColor = MaterialTheme.colorScheme.surface
                            )
                        )
                        Box(
                            modifier = Modifier
                                .size(46.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(
                                    if (textInput.isNotBlank()) Brush.linearGradient(listOf(accent2, accent))
                                    else Brush.linearGradient(listOf(Color(0xFF98ABB5), Color(0xFF98ABB5)))
                                )
                                .clickable {
                                    if (textInput.isNotBlank()) {
                                        val replyId = replyTarget?.id?.toLongOrNull()
                                        onSendMessage(textInput.trim(), replyId)
                                        textInput = ""
                                        replyTarget = null
                                        onTyping(false)
                                    }
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = "Send",
                                tint = Color.White,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageBubble(
    message: ChatMessage,
    myId: String,
    onLongPress: () -> Unit = {},
    onReply: (ChatMessage) -> Unit = {}
) {
    val isMine = message.senderId == myId || message.isMine
    val accent = Color(0xFF0B8C72)

    // Colors matching web app
    val bubbleBg = if (isMine) {
        Brush.linearGradient(
            listOf(Color(0xFFD9FFF2), Color(0xFFBFE9DC)),
            start = androidx.compose.ui.geometry.Offset(0f, 0f),
            end = androidx.compose.ui.geometry.Offset(1f, 1f)
        )
    } else {
        Brush.linearGradient(listOf(Color.White, Color.White))
    }
    val textColor = if (isMine) Color(0xFF12362F) else Color(0xFF17242B)
    // Tick color: for dark-bg bubbles use light; for light-bg use dark
    val tickColor = if (isMine) textColor.copy(alpha = 0.72f) else Color(0xFF8A9BA8)
    val shape = if (isMine) {
        RoundedCornerShape(16.dp, 16.dp, 5.dp, 16.dp)
    } else {
        RoundedCornerShape(16.dp, 16.dp, 16.dp, 5.dp)
    }

    // Swipe-to-reply state
    var dragOffset by remember { mutableStateOf(0f) }
    var showReplyArrow by remember { mutableStateOf(false) }
    val animatedDrag by animateFloatAsState(targetValue = dragOffset.coerceIn(-40f, 40f), label = "drag")

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .pointerInput(message.id) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (isMine && dragOffset < -60f) {
                            onReply(message)
                            showReplyArrow = true
                        } else if (!isMine && dragOffset > 60f) {
                            onReply(message)
                            showReplyArrow = true
                        }
                        dragOffset = 0f
                    },
                    onDragCancel = { dragOffset = 0f },
                    onHorizontalDrag = { _, dragAmount ->
                        if (isMine) {
                            if (dragAmount < 0) dragOffset += dragAmount
                        } else {
                            if (dragAmount > 0) dragOffset += dragAmount
                        }
                    }
                )
            }
    ) {
        // Reply arrow indicator
        AnimatedVisibility(
            visible = (if (isMine) dragOffset < -20f else dragOffset > 20f) || showReplyArrow,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(if (isMine) Alignment.CenterStart else Alignment.CenterEnd)
        ) {
            Icon(
                Icons.Default.Reply,
                contentDescription = "Reply",
                tint = accent,
                modifier = Modifier
                    .padding(horizontal = 8.dp)
                    .size(22.dp)
            )
            LaunchedEffect(showReplyArrow) {
                if (showReplyArrow) {
                    kotlinx.coroutines.delay(600)
                    showReplyArrow = false
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .offset(x = animatedDrag.dp),
            horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(0.78f)
                    .wrapContentWidth(if (isMine) Alignment.End else Alignment.Start)
                    .clip(shape)
                    .background(bubbleBg)
                    .combinedClickable(onLongClick = onLongPress, onClick = {})
                    .padding(horizontal = 13.dp, vertical = 9.dp)
            ) {
                Column {
                    // Forwarded tag
                    if (message.forwardedFromId != null) {
                        Text("↪ Forwarded", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = textColor.copy(alpha = 0.72f))
                        Spacer(Modifier.height(2.dp))
                    }
                    // Reply quote — accent bar on left, content in Column on right
                    if (!message.replyBody.isNullOrBlank()) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color.Black.copy(alpha = 0.05f))
                                .padding(start = 6.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.Top
                        ) {
                            // Accent bar on left
                            Box(
                                Modifier
                                    .width(3.dp)
                                    .height(32.dp)
                                    .background(accent, RoundedCornerShape(2.dp))
                            )
                            Spacer(Modifier.width(8.dp))
                            // Text content on right
                            Column {
                                Text(
                                    message.replySenderName ?: "User",
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = accent
                                )
                                Text(
                                    message.replyBody,
                                    fontSize = 11.sp,
                                    color = textColor.copy(alpha = 0.8f),
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                    }

                    // Media
                    val media = message.media
                    if (media != null) {
                        when {
                            media.mime.startsWith("image/") -> {
                                AsyncImage(
                                    model = media.url,
                                    contentDescription = media.originalName,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = 220.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                )
                            }
                            media.mime.startsWith("video/") -> {
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(140.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(Color.Black.copy(.6f)),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(Icons.Default.PlayCircle, null, Modifier.size(48.dp), tint = Color.White)
                                    Text(
                                        media.originalName,
                                        color = Color.White,
                                        fontSize = 11.sp,
                                        modifier = Modifier
                                            .align(Alignment.BottomCenter)
                                            .padding(8.dp)
                                    )
                                }
                            }
                            else -> {
                                Row(
                                    Modifier
                                        .clip(RoundedCornerShape(11.dp))
                                        .background(Color.Black.copy(.07f))
                                        .padding(9.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Icon(Icons.Default.AttachFile, null, tint = textColor, modifier = Modifier.size(20.dp))
                                    Column {
                                        Text(media.originalName, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = textColor)
                                        Text(formatFileSize(media.size), fontSize = 10.sp, color = textColor.copy(.7f))
                                    }
                                }
                            }
                        }
                        if (message.text.isNotBlank()) Spacer(Modifier.height(4.dp))
                    }

                    // Message text
                    if (message.text.isNotBlank()) {
                        Text(
                            message.text,
                            color = textColor,
                            fontSize = 14.sp,
                            lineHeight = 20.sp
                        )
                    }

                    // Reactions
                    if (message.reactions.isNotEmpty()) {
                        Spacer(Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            val grouped = message.reactions.groupBy { it.emoji }
                            grouped.forEach { (emoji, group) ->
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(999.dp))
                                        .background(MaterialTheme.colorScheme.surfaceVariant)
                                        .padding(horizontal = 7.dp, vertical = 2.dp)
                                ) {
                                    Text("$emoji ${group.size}", fontSize = 12.sp)
                                }
                            }
                        }
                    }

                    // Time + ticks
                    Row(
                        modifier = Modifier
                            .align(Alignment.End)
                            .padding(top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        if (!message.editedAt.isNullOrBlank()) {
                            Text(
                                "edited",
                                fontSize = 10.sp,
                                color = textColor.copy(.72f),
                                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic
                            )
                        }
                        Text(
                            formatTime(message.createdAt ?: message.timestamp.toString()),
                            fontSize = 10.sp,
                            color = textColor.copy(alpha = 0.72f)
                        )
                        if (isMine) {
                            TickMarks(message.deliveredAt, message.readAt)
                        }
                    }
                }
            }
        }
    }
}

private fun formatTime(value: String): String {
    return try {
        // Try ISO
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
        val date = sdf.parse(value.substringBefore(".")) ?: return value
        SimpleDateFormat("h:mm a", Locale.getDefault()).format(date)
    } catch (_: Exception) {
        try {
            // Try millis
            val ts = value.toLong()
            SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(ts))
        } catch (_: Exception) { value }
    }
}

fun formatLastSeen(lastSeen: String): String {
    return try {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
        val date = sdf.parse(lastSeen.substringBefore(".")) ?: return "last seen recently"
        val now = Date()
        val diff = now.time - date.time
        val mins = diff / 60000
        when {
            mins < 1 -> "just now"
            mins < 60 -> "last seen ${mins}m ago"
            mins < 1440 -> {
                val t = SimpleDateFormat("h:mm a", Locale.getDefault()).format(date)
                "last seen today at $t"
            }
            mins < 2880 -> "last seen yesterday"
            else -> {
                val d = SimpleDateFormat("dd MMM", Locale.getDefault()).format(date)
                "last seen $d"
            }
        }
    } catch (_: Exception) { "last seen recently" }
}

private fun formatFileSize(bytes: Long): String {
    return when {
        bytes < 1024 -> "${bytes}B"
        bytes < 1048576 -> "${bytes / 1024}KB"
        else -> "${"%.1f".format(bytes / 1048576.0)}MB"
    }
}
