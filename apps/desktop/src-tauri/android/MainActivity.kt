package io.github.devrafaelbrauner.simplemd

import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// Scripts constantes do próprio app; nada vindo da página é executado. A MainActivity não adiciona
// ponte nativa (addJavascriptInterface); o IPC do Tauri/Wry continua existindo.
private const val SCRIPT_FECHAR_CAMADA =
  "(function(){" +
    "if(!document.querySelector('[role=dialog],[role=alertdialog],[role=menu]'))return false;" +
    "(document.activeElement||document.body).dispatchEvent(" +
    "new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));" +
    "return true;})()"

private const val SCRIPT_COR_DO_APP =
  "(function(){" +
    "var c=getComputedStyle(document.querySelector('.smd-toolbar')||document.documentElement).backgroundColor;" +
    "if(c==='rgba(0, 0, 0, 0)')c=getComputedStyle(document.documentElement).backgroundColor;" +
    "return c;})()"

private const val INTERVALO_COR_MS = 1500L
private const val LIMITE_VOLTAR_MS = 1000L

// Aceita "rgb(r, g, b)" e "rgba(r, g, b, a)" (também dentro das aspas do retorno do evaluateJavascript).
// Qualquer outra coisa (por exemplo "color(srgb ...)"), ou alfa menor que 1, devolve null.
internal fun parseCor(texto: String?): Int? {
  if (texto == null || !Regex("""^\s*"?\s*rgba?\(""").containsMatchIn(texto)) return null
  val numeros = Regex("""\d+(?:\.\d+)?""").findAll(texto).mapNotNull { it.value.toFloatOrNull() }.toList()
  if (numeros.size < 3 || numeros.size > 4) return null
  if (numeros.size == 3 && texto.contains('%')) return null
  if (numeros.size == 4 && numeros[3] / (if (texto.contains('%')) 100f else 1f) < 1f) return null
  val (r, g, b) = numeros.take(3).map { it.toInt().coerceIn(0, 255) }
  return Color.rgb(r, g, b)
}

internal fun corClara(cor: Int): Boolean =
  (0.299 * Color.red(cor) + 0.587 * Color.green(cor) + 0.114 * Color.blue(cor)) / 255.0 > 0.5

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var ultimaCor: Int? = null
  private val handler = Handler(Looper.getMainLooper())
  private val lerCor = object : Runnable {
    override fun run() {
      webView?.evaluateJavascript(SCRIPT_COR_DO_APP) { aplicarCor(parseCor(it)) }
      handler.postDelayed(this, INTERVALO_COR_MS)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge-to-edge é obrigatório no Android 15+: o app desenha sob as barras do sistema.
    // Aplica barras, recorte e teclado como padding da view de conteúdo e consome os insets,
    // então o WebView não os recebe de novo (env(safe-area-inset-*) vale 0 e o CSS não duplica o espaço).
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // Chamado pelo WryActivity logo depois de registrar o callback de Voltar dele; este, registrado
  // depois, tem prioridade. Voltar pede ao WebView para fechar a camada aberta (Escape); o resultado
  // chega assíncrono, então o evento é sempre consumido e repassado ao próximo callback (o do Wry:
  // histórico ou sair do app) quando não havia camada, quando o WebView lança ou quando não responde
  // em 1 s. O repasse acontece uma só vez, o que vier primeiro.
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        var resolvido = false
        lateinit var limite: Runnable
        fun resolver(consumido: Boolean) {
          if (resolvido) return
          resolvido = true
          handler.removeCallbacks(limite)
          if (!consumido) {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
        limite = Runnable { resolver(false) }
        handler.postDelayed(limite, LIMITE_VOLTAR_MS)
        try {
          webView.evaluateJavascript(SCRIPT_FECHAR_CAMADA) { resolver(it == "true") }
        } catch (e: Exception) {
          resolver(false)
        }
      }
    })
  }

  // O nativo puxa a cor do app (o JS só devolve uma string) e pinta o fundo atrás das barras
  // e a cor dos ícones; só reage quando a cor muda.
  private fun aplicarCor(cor: Int?) {
    if (cor == null || cor == ultimaCor) return
    ultimaCor = cor
    val conteudo = findViewById<View>(android.R.id.content)
    conteudo.setBackgroundColor(cor)
    val controle = WindowCompat.getInsetsController(window, conteudo)
    controle.isAppearanceLightStatusBars = corClara(cor)
    controle.isAppearanceLightNavigationBars = corClara(cor)
  }

  override fun onResume() {
    super.onResume()
    handler.removeCallbacks(lerCor)
    handler.post(lerCor)
  }

  override fun onPause() {
    handler.removeCallbacks(lerCor)
    super.onPause()
  }

  override fun onDestroy() {
    handler.removeCallbacks(lerCor)
    super.onDestroy()
  }
}
