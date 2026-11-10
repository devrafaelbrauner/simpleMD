//! Portão de sessão do `ai_send` (r31, D-R31-01..05). Plugins aprovados rodam no realm do app e
//! alcançam o IPC (`docs/plugins.md`), então a pergunta fica no Rust, depois da política e antes da
//! vaga, da chave e de qualquer socket: o 1º pedido a cada provedor de nuvem na sessão (processo)
//! abre o diálogo nativo das chaves (`KeyAction::Use`, um diálogo por vez). Aceito, o provedor
//! segue sem perguntar até o app fechar (sem "revogar": exigiria outro comando, D-R31-02).
//! Recusado, `SEND_NOT_CONFIRMED` e nada sai; por 15 s o provedor é recusado sem diálogo (um
//! plugin em laço não prende a janela, D-R31-03). O Ollama (loopback, sem chave) não pergunta.
//! "Permitir" dado antes de 1 s com o diálogo aberto vale como recusa (D-R31-08): um plugin vê as
//! teclas e pode abrir o diálogo bem na hora de um Return, e o diálogo do sistema põe o padrão em
//! "Permitir" (não dá para trocar o botão padrão nos dois SO).
//!
//! O contador (D-R31-05) conta os pedidos despachados, nuvem e Ollama, e é publicado ao webview
//! pelo evento `ai-usage` (o webview não tem `allow-emit`: não forja o evento pelo IPC).

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use super::keys::{Confirm, KeyAction};
use super::policy::{Checked, Provider};
use crate::error::AppError;

/// Recusa automática depois de um "Cancelar" (D-R31-03).
pub const REFUSAL_COOLDOWN: Duration = Duration::from_secs(15);
/// "Permitir" antes disto, contado de quando a janela do diálogo aparece, vale como recusa
/// (D-R31-08; `Confirm::confirm_timed`).
pub const MIN_DECISION: Duration = Duration::from_secs(1);
/// Evento com o total acumulado de pedidos da sessão (`AiUsage`). O TS escuta o mesmo nome
/// (`check-tauri-security.mjs`, `AI_SEND_GATE`).
pub const USAGE_EVENT: &str = "ai-usage";

/// Pedidos de IA despachados nesta sessão.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct AiUsage {
    pub cloud: u32,
    pub local: u32,
}

#[derive(Default)]
struct Session {
    /// OpenAI, Anthropic.
    approved: [bool; 2],
    refused_at: [Option<Instant>; 2],
    /// Um diálogo deste portão aberto: outro pedido de nuvem falha na hora (sem thread parada).
    asking: bool,
}

pub struct SessionGate {
    confirm: Arc<dyn Confirm>,
    cooldown: Duration,
    min_decision: Duration,
    state: Mutex<Session>,
    usage: Mutex<AiUsage>,
}

fn cloud_slot(provider: Provider) -> Option<usize> {
    match provider {
        Provider::Openai => Some(0),
        Provider::Anthropic => Some(1),
        Provider::Ollama => None,
    }
}

fn denied() -> AppError {
    AppError::new("SEND_NOT_CONFIRMED")
}

/// Tamanho do corpo para o diálogo: "menos de 1 KB", "12 KB", "1,2 MB".
pub fn size_label(bytes: usize) -> String {
    const KIB: usize = 1024;
    const MIB: usize = 1024 * 1024;
    if bytes < KIB {
        return "menos de 1 KB".to_owned();
    }
    let kb = (bytes + KIB / 2) / KIB;
    if kb < KIB {
        return format!("{kb} KB");
    }
    let tenths = (bytes * 10 + MIB / 2) / MIB;
    match tenths % 10 {
        0 => format!("{} MB", tenths / 10),
        frac => format!("{},{frac} MB", tenths / 10),
    }
}

impl SessionGate {
    pub fn new(confirm: Arc<dyn Confirm>) -> Self {
        Self::with_timing(confirm, REFUSAL_COOLDOWN, MIN_DECISION)
    }

    /// Tempos trocáveis: só os testes usam outros valores.
    pub fn with_timing(
        confirm: Arc<dyn Confirm>,
        cooldown: Duration,
        min_decision: Duration,
    ) -> Self {
        Self {
            confirm,
            cooldown,
            min_decision,
            state: Mutex::default(),
            usage: Mutex::default(),
        }
    }

    /// Deixa passar ou recusa um pedido já aprovado pela política. Pode abrir o diálogo nativo
    /// (bloqueia): só fora da thread principal.
    pub fn admit(&self, checked: &Checked) -> Result<(), AppError> {
        let Some(slot) = cloud_slot(checked.provider) else {
            return Ok(());
        };
        {
            let mut state = self.state.lock();
            if state.approved[slot] {
                return Ok(());
            }
            let cooling = state.refused_at[slot].is_some_and(|at| at.elapsed() < self.cooldown);
            if state.asking || cooling {
                return Err(denied());
            }
            state.asking = true;
        }
        // A trava fica solta durante o diálogo; `Asking` desfaz a marca se o diálogo entrar em
        // pânico. No caminho normal, a marca sai na MESMA seção crítica que grava o resultado:
        // senão um pedido em laço entra entre as duas e abre outro diálogo dentro dos 15 s
        // (AppSec r31 F1).
        let asking = Asking(&self.state);
        let action = KeyAction::Use {
            bytes: checked.body.as_ref().map_or(0, String::len),
            listing: checked.method == "GET",
        };
        let (answer, open) = self.confirm.confirm_timed(action, checked.provider.name());
        // Return logo que o diálogo abriu não vale (D-R31-08): o tempo conta da janela na tela,
        // não da chamada (R31-PREPARE-CFG). Um diálogo de chave aberto (`OneAtATime` devolve
        // `false`) também conta como recusa, com a espera (documentado).
        let allowed = answer && open >= self.min_decision;
        std::mem::forget(asking);
        let mut state = self.state.lock();
        state.asking = false;
        if allowed {
            state.approved[slot] = true;
            Ok(())
        } else {
            state.refused_at[slot] = Some(Instant::now());
            Err(denied())
        }
    }

    /// Conta um pedido despachado e publica o total. `publish` roda com a trava do contador: os
    /// totais saem em ordem crescente mesmo com pedidos simultâneos.
    pub fn record(&self, provider: Provider, publish: impl FnOnce(AiUsage)) {
        let mut usage = self.usage.lock();
        match provider {
            Provider::Ollama => usage.local = usage.local.saturating_add(1),
            _ => usage.cloud = usage.cloud.saturating_add(1),
        }
        publish(*usage);
    }
}

struct Asking<'a>(&'a Mutex<Session>);

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.lock().asking = false;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Barrier;

    use super::*;

    fn checked(provider: Provider, method: &'static str, body: Option<&str>) -> Checked {
        Checked {
            provider,
            method,
            path: "/v1/chat/completions",
            base: "https://example.invalid".into(),
            headers: Vec::new(),
            body: body.map(str::to_owned),
        }
    }

    /// Resposta trocável do diálogo, guardando as perguntas.
    #[derive(Default)]
    struct Fake {
        answer: AtomicBool,
        asked: Mutex<Vec<(KeyAction, String)>>,
    }

    impl Fake {
        fn answering(answer: bool) -> Arc<Self> {
            let fake = Arc::new(Self::default());
            fake.answer.store(answer, Ordering::SeqCst);
            fake
        }
        fn asked(&self) -> usize {
            self.asked.lock().len()
        }
    }

    impl Confirm for Fake {
        fn confirm(&self, action: KeyAction, provider: &str) -> bool {
            self.asked.lock().push((action, provider.to_owned()));
            self.answer.load(Ordering::SeqCst)
        }
    }

    /// Portão sem o tempo mínimo de decisão: os falsos respondem na hora.
    fn instant(confirm: Arc<dyn Confirm>) -> SessionGate {
        SessionGate::with_timing(confirm, REFUSAL_COOLDOWN, Duration::ZERO)
    }

    #[test]
    fn first_cloud_request_asks_once_per_provider() {
        let fake = Fake::answering(true);
        let gate = instant(fake.clone());
        let chat = checked(Provider::Openai, "POST", Some("{\"x\":1}"));
        gate.admit(&chat).unwrap();
        gate.admit(&chat).unwrap();
        gate.admit(&checked(Provider::Openai, "GET", None)).unwrap();
        assert_eq!(fake.asked(), 1);
        // Outro provedor de nuvem, outra chave: pergunta de novo (D-R31-02).
        gate.admit(&checked(Provider::Anthropic, "GET", None))
            .unwrap();
        assert_eq!(fake.asked(), 2);
        let asked = fake.asked.lock();
        assert_eq!(
            asked[0],
            (
                KeyAction::Use {
                    bytes: 7,
                    listing: false
                },
                "openai".to_owned()
            )
        );
        // A lista de modelos também passa pelo portão (D-R31-04).
        assert_eq!(
            asked[1],
            (
                KeyAction::Use {
                    bytes: 0,
                    listing: true
                },
                "anthropic".to_owned()
            )
        );
    }

    #[test]
    fn ollama_never_asks() {
        let fake = Fake::answering(false);
        let gate = SessionGate::new(fake.clone());
        for _ in 0..3 {
            gate.admit(&checked(Provider::Ollama, "POST", Some("{}")))
                .unwrap();
        }
        assert_eq!(fake.asked(), 0);
    }

    #[test]
    fn refusal_is_typed_and_cools_down() {
        let fake = Fake::answering(false);
        let gate = instant(fake.clone());
        let chat = checked(Provider::Openai, "POST", Some("{}"));
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
        // Dentro dos 15 s: recusado sem outro diálogo, mesmo que o usuário fosse aceitar.
        fake.answer.store(true, Ordering::SeqCst);
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
        assert_eq!(fake.asked(), 1);
        // A espera é por provedor.
        gate.admit(&checked(Provider::Anthropic, "POST", Some("{}")))
            .unwrap();
        assert_eq!(fake.asked(), 2);
    }

    #[test]
    fn after_the_cooldown_it_asks_again() {
        let fake = Fake::answering(false);
        let gate = SessionGate::with_timing(fake.clone(), Duration::ZERO, Duration::ZERO);
        let chat = checked(Provider::Anthropic, "POST", Some("{}"));
        assert!(gate.admit(&chat).is_err());
        fake.answer.store(true, Ordering::SeqCst);
        gate.admit(&chat).unwrap();
        gate.admit(&chat).unwrap();
        assert_eq!(fake.asked(), 2);
    }

    /// D-R31-08: "Permitir" logo que o diálogo abre (um Return já a caminho) vale como recusa, com
    /// a espera de 15 s; depois do tempo mínimo vale.
    #[test]
    fn a_permit_right_after_the_dialog_opens_is_a_refusal() {
        let fake = Fake::answering(true);
        let gate = SessionGate::new(fake.clone());
        let chat = checked(Provider::Openai, "POST", Some("{}"));
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
        assert_eq!(fake.asked(), 1, "a recusa rápida entra na espera");

        struct Deliberate;
        impl Confirm for Deliberate {
            fn confirm(&self, _: KeyAction, _: &str) -> bool {
                std::thread::sleep(Duration::from_millis(40));
                true
            }
        }
        let gate = SessionGate::with_timing(
            Arc::new(Deliberate),
            REFUSAL_COOLDOWN,
            Duration::from_millis(20),
        );
        gate.admit(&chat).unwrap();
        gate.admit(&chat).unwrap();
    }

    /// R31-PREPARE-CFG: o 1 s conta da janela na tela, não da chamada. Um diálogo que demora a
    /// aparecer (thread principal ocupada) e é aceito logo depois de aparecer vale como recusa.
    #[test]
    fn the_minimum_counts_from_when_the_window_appears() {
        struct LateWindow;
        impl Confirm for LateWindow {
            fn confirm(&self, action: KeyAction, provider: &str) -> bool {
                self.confirm_timed(action, provider).0
            }
            fn confirm_timed(&self, _: KeyAction, _: &str) -> (bool, Duration) {
                std::thread::sleep(Duration::from_millis(40)); // a janela ainda não apareceu
                (true, Duration::from_millis(5))
            }
        }
        let gate = SessionGate::with_timing(
            Arc::new(LateWindow),
            REFUSAL_COOLDOWN,
            Duration::from_millis(20),
        );
        let chat = checked(Provider::Openai, "POST", Some("{}"));
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
        // Sem 2º diálogo: a recusa entra na espera.
        assert_eq!(gate.admit(&chat).unwrap_err().code, "SEND_NOT_CONFIRMED");
    }

    /// `OneAtATime` repassa o tempo da janela de dentro e, ocupado, recusa com 0 s.
    #[test]
    fn one_at_a_time_passes_the_window_time_through() {
        struct Timed;
        impl Confirm for Timed {
            fn confirm(&self, _: KeyAction, _: &str) -> bool {
                true
            }
            fn confirm_timed(&self, _: KeyAction, _: &str) -> (bool, Duration) {
                (true, Duration::from_millis(1500))
            }
        }
        let guard = super::super::keys::OneAtATime::new(Timed);
        let action = KeyAction::Use {
            bytes: 0,
            listing: true,
        };
        assert_eq!(
            guard.confirm_timed(action, "openai"),
            (true, Duration::from_millis(1500))
        );
        let gate = SessionGate::new(Arc::new(guard));
        gate.admit(&checked(Provider::Openai, "POST", Some("{}")))
            .unwrap();
    }

    /// AppSec r31 F1 (regressão): um laço de pedidos não consegue um 2º diálogo dentro dos 15 s
    /// entre soltar `asking` e gravar a recusa. Antes da correção: 516 de 1500 rodadas.
    #[test]
    fn a_refusal_cannot_be_raced_into_a_second_dialog() {
        struct Slow(AtomicUsize);
        impl Confirm for Slow {
            fn confirm(&self, _: KeyAction, _: &str) -> bool {
                self.0.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_micros(300));
                false
            }
        }
        let rounds = 300;
        let mut hits = 0;
        for _ in 0..rounds {
            let slow = Arc::new(Slow(AtomicUsize::new(0)));
            let gate = Arc::new(SessionGate::new(slow.clone()));
            let stop = Arc::new(AtomicBool::new(false));
            let hammers: Vec<_> = (0..6)
                .map(|_| {
                    let (gate, stop) = (gate.clone(), stop.clone());
                    std::thread::spawn(move || {
                        while !stop.load(Ordering::Relaxed) {
                            let _ = gate.admit(&checked(Provider::Openai, "POST", Some("{}")));
                        }
                    })
                })
                .collect();
            std::thread::sleep(Duration::from_millis(3));
            stop.store(true, Ordering::Relaxed);
            for hammer in hammers {
                hammer.join().unwrap();
            }
            if slow.0.load(Ordering::SeqCst) > 1 {
                hits += 1;
            }
        }
        assert_eq!(
            hits, 0,
            "rodadas com 2º diálogo dentro da espera: {hits} de {rounds}"
        );
    }

    /// Diálogo que fica aberto até o teste mandar fechar.
    struct Held {
        open: Barrier,
        asked: AtomicUsize,
    }

    impl Confirm for Held {
        fn confirm(&self, _: KeyAction, _: &str) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.open.wait(); // aberto
            self.open.wait(); // fechado pelo teste
            true
        }
    }

    #[test]
    fn a_request_during_the_dialog_fails_at_once() {
        let held = Arc::new(Held {
            open: Barrier::new(2),
            asked: AtomicUsize::new(0),
        });
        let gate = Arc::new(instant(held.clone()));
        let first = {
            let gate = gate.clone();
            std::thread::spawn(move || gate.admit(&checked(Provider::Openai, "POST", Some("{}"))))
        };
        held.open.wait();
        // Com o diálogo aberto: recusado na hora, sem segundo diálogo (nem de outro provedor).
        for provider in [Provider::Openai, Provider::Anthropic] {
            let error = gate
                .admit(&checked(provider, "POST", Some("{}")))
                .unwrap_err();
            assert_eq!(error.code, "SEND_NOT_CONFIRMED");
        }
        // O Ollama não depende do diálogo.
        gate.admit(&checked(Provider::Ollama, "POST", Some("{}")))
            .unwrap();
        held.open.wait();
        first.join().unwrap().unwrap();
        // Aceito o primeiro: o provedor segue sem perguntar.
        gate.admit(&checked(Provider::Openai, "POST", Some("{}")))
            .unwrap();
        assert_eq!(held.asked.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn record_counts_cloud_and_local_in_order() {
        let gate = SessionGate::new(Fake::answering(true));
        let mut seen = Vec::new();
        gate.record(Provider::Openai, |u| seen.push(u));
        gate.record(Provider::Ollama, |u| seen.push(u));
        gate.record(Provider::Anthropic, |u| seen.push(u));
        assert_eq!(
            seen,
            [
                AiUsage { cloud: 1, local: 0 },
                AiUsage { cloud: 1, local: 1 },
                AiUsage { cloud: 2, local: 1 },
            ]
        );
        assert_eq!(
            serde_json::to_value(seen[2]).unwrap(),
            serde_json::json!({ "cloud": 2, "local": 1 })
        );
    }

    #[test]
    fn size_labels() {
        assert_eq!(size_label(0), "menos de 1 KB");
        assert_eq!(size_label(1023), "menos de 1 KB");
        assert_eq!(size_label(1024), "1 KB");
        assert_eq!(size_label(12_345), "12 KB");
        assert_eq!(size_label(1024 * 1024 - 1), "1 MB");
        assert_eq!(size_label(1_258_291), "1,2 MB");
        assert_eq!(size_label(4 * 1024 * 1024), "4 MB");
    }
}
