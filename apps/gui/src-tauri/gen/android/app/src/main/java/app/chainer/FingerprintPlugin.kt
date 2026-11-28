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
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

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
 * Fingerprint unlock. The wallet password is encrypted with the public half of an RSA key pair
 * whose private half lives in the Android Keystore and can only be used right after a strong
 * biometric check, so the stored copy is useless without the owner's finger. Encrypting needs no
 * fingerprint, which lets the app turn this on by itself after a password unlock. Adding a
 * fingerprint to the phone destroys the key (Android does that); this is then switched off and
 * stays off until the owner turns it on again, so a newly added finger never gets in by itself.
 *
 * Per wallet, SharedPreferences hold the ciphertext (`<wallet>.data`) and, once the owner turned
 * it off or the key was destroyed, `<wallet>.off`, which stops the automatic turning on.
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

  /** Removes the stored password and the key; `off` also stops the automatic turning on. */
  private fun forget(wallet: String, off: Boolean) {
    val edit = prefs.edit().remove("$wallet.data")
    if (off) edit.putBoolean("$wallet.off", true) else edit.remove("$wallet.off")
    edit.apply()
    keyStore().deleteEntry(alias(wallet))
  }

  // OAEP with SHA-256, and MGF1 with SHA-1: the MGF1 digest the Keystore supports on every version.
  private val oaep = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)
  private fun rsa() = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")

  private fun newKeyPair(wallet: String) {
    val spec = KeyGenParameterSpec.Builder(alias(wallet), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(2048)
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
      // Every use of the private key needs a fresh fingerprint (no validity window), and a newly
      // added fingerprint makes it unusable. The public key is free to use.
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").run {
      initialize(spec)
      generateKeyPair()
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
    val wallet = invoke.parseArgs(WalletArgs::class.java).wallet
    invoke.resolve(JSObject().apply {
      put("available", available())
      put("enabled", enabled(wallet))
      put("off", prefs.getBoolean("$wallet.off", false))
    })
  }

  /** Stores the password under a new key pair; needs no fingerprint (only the public key is used). */
  @Command
  fun enable(invoke: Invoke) {
    val args = invoke.parseArgs(EnableArgs::class.java)
    if (!available()) return invoke.resolve(outcome(false, "unavailable", "This phone has no fingerprint set up"))
    forget(args.wallet, off = false)
    newKeyPair(args.wallet)
    // Encrypt outside the Keystore with a plain copy of the public key: the Keystore's own
    // public-key operations would ask for the fingerprint too.
    val stored = keyStore().getCertificate(alias(args.wallet)).publicKey
    val public = KeyFactory.getInstance(stored.algorithm).generatePublic(X509EncodedKeySpec(stored.encoded))
    val data = rsa().run {
      init(Cipher.ENCRYPT_MODE, public, oaep)
      doFinal(args.password.toByteArray(Charsets.UTF_8))
    }
    prefs.edit().putString("${args.wallet}.data", Base64.encodeToString(data, Base64.NO_WRAP)).apply()
    invoke.resolve(outcome(true))
  }

  @Command
  fun unlock(invoke: Invoke) {
    val wallet = invoke.parseArgs(WalletArgs::class.java).wallet
    if (!enabled(wallet)) return invoke.resolve(outcome(false, "off"))
    val data = Base64.decode(prefs.getString("$wallet.data", null), Base64.NO_WRAP)
    val cipher = rsa()
    try {
      cipher.init(Cipher.DECRYPT_MODE, keyStore().getKey(alias(wallet), null) as PrivateKey, oaep)
    } catch (e: KeyPermanentlyInvalidatedException) {
      forget(wallet, off = true)
      return invoke.resolve(outcome(false, "invalidated", "A fingerprint was added to this phone, so fingerprint unlock was turned off"))
    }
    prompt(invoke, "Unlock chainer", "Wallet $wallet", cipher) { c ->
      invoke.resolve(outcome(true).apply { put("password", String(c.doFinal(data), Charsets.UTF_8)) })
    }
  }

  /** Turns it off for good (until turned on again): the owner chose so, or the password went stale. */
  @Command
  fun disable(invoke: Invoke) {
    forget(invoke.parseArgs(WalletArgs::class.java).wallet, off = true)
    invoke.resolve(outcome(true))
  }
}
