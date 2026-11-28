package app.chainer

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class WalletArgs {
  lateinit var wallet: String
}

@InvokeArg
class EnableArgs {
  lateinit var wallet: String
  lateinit var password: String
}

/**
 * Fingerprint unlock. The wallet password is encrypted with an AES key that lives in the Android
 * Keystore and can only be used right after a strong biometric check, so the stored copy is
 * useless without the owner's finger. Adding a fingerprint to the phone destroys the key (Android
 * does that), and the password has to be typed once to turn this on again.
 *
 * Expected outcomes (cancelled, key gone, no fingerprint hardware) resolve with `ok: false` and a
 * `reason`, so the page can tell them apart; only unexpected failures reject.
 */
@TauriPlugin
class FingerprintPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = activity.getSharedPreferences("fingerprint", Context.MODE_PRIVATE)

  private fun alias(wallet: String) = "chainer-fingerprint:$wallet"

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun available() = BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

  private fun enabled(wallet: String) = prefs.contains("$wallet.data") && keyStore().containsAlias(alias(wallet))

  private fun forget(wallet: String) {
    prefs.edit().remove("$wallet.data").remove("$wallet.iv").apply()
    keyStore().deleteEntry(alias(wallet))
  }

  private fun newKey(wallet: String): SecretKey {
    val spec = KeyGenParameterSpec.Builder(alias(wallet), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      // Every use needs a fresh fingerprint (no validity window), and a newly added
      // fingerprint makes the key unusable.
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(spec)
      generateKey()
    }
  }

  private fun outcome(ok: Boolean, reason: String? = null, message: String? = null) = JSObject().apply {
    put("ok", ok)
    if (reason != null) put("reason", reason)
    if (message != null) put("message", message)
  }

  /** Shows the system fingerprint prompt for `cipher`; `onDone` gets the unlocked cipher. */
  private fun prompt(invoke: Invoke, title: String, subtitle: String, cipher: Cipher, onDone: (Cipher) -> Unit) {
    activity.runOnUiThread {
      val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            onDone(result.cryptoObject!!.cipher!!)
          } catch (e: Exception) {
            invoke.reject("Fingerprint unlock failed: ${e.message}", e)
          }
        }

        override fun onAuthenticationError(code: Int, text: CharSequence) {
          val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED
          invoke.resolve(outcome(false, if (cancelled) "cancelled" else "error", text.toString()))
        }
        // A finger that does not match is shown by the prompt itself, which stays open.
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setSubtitle(subtitle)
        .setNegativeButtonText("Use password")
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .build()
      BiometricPrompt(activity as FragmentActivity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  @Command
  fun status(invoke: Invoke) {
    val args = invoke.parseArgs(WalletArgs::class.java)
    invoke.resolve(JSObject().apply {
      put("available", available())
      put("enabled", enabled(args.wallet))
    })
  }

  @Command
  fun enable(invoke: Invoke) {
    val args = invoke.parseArgs(EnableArgs::class.java)
    if (!available()) return invoke.resolve(outcome(false, "unavailable", "This phone has no fingerprint set up"))
    forget(args.wallet)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newKey(args.wallet)) }
    prompt(invoke, "Turn on fingerprint unlock", "Wallet ${args.wallet}", cipher) { c ->
      val data = c.doFinal(args.password.toByteArray(Charsets.UTF_8))
      prefs.edit()
        .putString("${args.wallet}.data", Base64.encodeToString(data, Base64.NO_WRAP))
        .putString("${args.wallet}.iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
        .apply()
      invoke.resolve(outcome(true))
    }
  }

  @Command
  fun unlock(invoke: Invoke) {
    val wallet = invoke.parseArgs(WalletArgs::class.java).wallet
    if (!enabled(wallet)) return invoke.resolve(outcome(false, "off"))
    val data = Base64.decode(prefs.getString("$wallet.data", null), Base64.NO_WRAP)
    val iv = Base64.decode(prefs.getString("$wallet.iv", null), Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    try {
      cipher.init(Cipher.DECRYPT_MODE, keyStore().getKey(alias(wallet), null) as SecretKey, GCMParameterSpec(128, iv))
    } catch (e: KeyPermanentlyInvalidatedException) {
      forget(wallet)
      return invoke.resolve(outcome(false, "invalidated", "A fingerprint was added to this phone, so fingerprint unlock was turned off"))
    }
    prompt(invoke, "Unlock chainer", "Wallet $wallet", cipher) { c ->
      invoke.resolve(outcome(true).apply { put("password", String(c.doFinal(data), Charsets.UTF_8)) })
    }
  }

  @Command
  fun disable(invoke: Invoke) {
    forget(invoke.parseArgs(WalletArgs::class.java).wallet)
    invoke.resolve(outcome(true))
  }
}
