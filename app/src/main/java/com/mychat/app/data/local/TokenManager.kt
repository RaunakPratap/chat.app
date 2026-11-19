package com.mychat.app.data.local

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "mychat_prefs")

class TokenManager(private val context: Context) {

    companion object {
        val TOKEN_KEY = stringPreferencesKey("auth_token")
        val USER_ID_KEY = stringPreferencesKey("user_id")
        val USERNAME_KEY = stringPreferencesKey("username")
        val SERVER_URL_KEY = stringPreferencesKey("server_url")
        val SCREENSHOT_BLOCK_KEY = booleanPreferencesKey("screenshot_block")
        val SHAKE_TO_DELETE_KEY = booleanPreferencesKey("shake_to_delete")
        val SHAKE_DELETE_MODE_KEY = stringPreferencesKey("shake_delete_mode")
        val SHAKE_SENSITIVITY_KEY = stringPreferencesKey("shake_sensitivity")
        val SHAKE_SELECTED_USERS_KEY = stringPreferencesKey("shake_selected_users")
    }

    val tokenFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[TOKEN_KEY]
    }

    val userIdFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[USER_ID_KEY]
    }

    val usernameFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[USERNAME_KEY]
    }

    val serverUrlFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[SERVER_URL_KEY]
    }

    val screenshotBlockFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SCREENSHOT_BLOCK_KEY] ?: true // Default to true for native security
    }

    val shakeToDeleteFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHAKE_TO_DELETE_KEY] ?: true
    }

    val shakeDeleteModeFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[SHAKE_DELETE_MODE_KEY] ?: "current"
    }

    val shakeSensitivityFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[SHAKE_SENSITIVITY_KEY] ?: "medium"
    }

    val shakeSelectedUsersFlow: Flow<Set<String>> = context.dataStore.data.map { prefs ->
        prefs[SHAKE_SELECTED_USERS_KEY]?.split(",")?.filter { it.isNotBlank() }?.toSet() ?: emptySet()
    }

    suspend fun saveShakeSettings(
        enabled: Boolean,
        mode: String,
        sensitivity: String,
        selectedUsers: Set<String> = emptySet()
    ) {
        context.dataStore.edit { prefs ->
            prefs[SHAKE_TO_DELETE_KEY] = enabled
            prefs[SHAKE_DELETE_MODE_KEY] = mode
            prefs[SHAKE_SENSITIVITY_KEY] = sensitivity
            prefs[SHAKE_SELECTED_USERS_KEY] = selectedUsers.joinToString(",")
        }
    }

    suspend fun saveSession(token: String, userId: String, username: String) {
        context.dataStore.edit { prefs ->
            prefs[TOKEN_KEY] = token
            prefs[USER_ID_KEY] = userId
            prefs[USERNAME_KEY] = username
        }
    }

    suspend fun saveServerUrl(url: String) {
        context.dataStore.edit { prefs ->
            prefs[SERVER_URL_KEY] = url
        }
    }

    suspend fun saveScreenshotBlock(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SCREENSHOT_BLOCK_KEY] = enabled
        }
    }

    suspend fun clearSession() {
        context.dataStore.edit { prefs ->
            prefs.remove(TOKEN_KEY)
            prefs.remove(USER_ID_KEY)
            prefs.remove(USERNAME_KEY)
        }
    }
}
