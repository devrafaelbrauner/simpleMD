//! Corretor ortográfico offline (r34, fatia 9 do p26; design-r34 §1, D-R34-1..9). Motor compatível
//! com o Hunspell (`spellbook` 0.4.2, MPL-2.0; D-P26-07) com o pt_BR do VERO embutido no binário
//! (`include_str!`, D-R34-1: os mesmos bytes em teste, dev e release; LibreOffice/dictionaries no
//! commit de D-R34-2, licença eleita MPL-2.0, texto em `dictionaries/MPL-2.0.txt`) mais as camadas do
//! usuário (D-P26-03), lidas por `vault::dictionaries` (`GlobalDictionaries::engine_sources`,
//! D-R34-5): os termos `.txt` da camada global e da pasta num dicionário próprio (design-r34 §1) e
//! os pares `.dic`/`.aff` das listas importadas (r33), entrada NÃO confiável (AppSec r33a N5,
//! D-R34-4).
//!
//! Três comandos (D-R34-4), cada um numa thread de bloqueio (`vault::blocking`):
//! - `spell_check { lang, words }` → os índices das palavras que nem a base, nem os termos, nem os
//!   pares conhecem. Só `pt-BR` (`UNSUPPORTED_LANG`); mais de 20.000 → `TOO_MANY_WORDS { max }`. A
//!   palavra vai a NFC (design-r34 §1); a que não é termo v1 (vazia, mais de 64 caracteres, espaço,
//!   Cc ou Cf) nunca é marcada. O pedido mais novo vence: o anterior para com `CANCELLED` e
//!   `words: []` só cancela (devolve `[]`). Passou de 3 s → `TIMEOUT { seconds }`, e o par que
//!   segurava a thread das consultas fica desligado até o próximo `spell_reload` (AppSec r34 B1');
//!   os outros pares seguem ligados.
//! - `spell_suggest { lang, word }` → até 5 sugestões: as edições da base, dos termos e dos pares,
//!   nessa ordem; o n-grama da base (lento) só se nenhuma delas trouxer palavra única; palavra única
//!   antes de forma com espaço (D-R34-6); só sai texto que vale como termo, sem marcação, invisível
//!   nem homóglifo (`presentable`; AppSec r34 N1/N1'). Um cálculo por vez; o pedido mais novo vence
//!   (`CANCELLED`); a parte dos pares passou de 3 s → `TIMEOUT { seconds }`, com o par que segurava
//!   a thread desligado do mesmo jeito.
//! - `spell_reload { token? }` → `{ langs, words, pairs, skipped }`: a base carrega no primeiro
//!   pedido de qualquer comando (`LazyLock`); relê a camada global e, com `token`, a da pasta
//!   (`VaultState::root`: `NO_VAULT`, `VAULT_CLOSED`) e troca as camadas de uma vez (`Arc`). Recarga
//!   mais nova vence (`CANCELLED`).
//!
//! Os pares só rodam em duas threads dedicadas do estado (AppSec r34 B1/B2), um trabalho por vez em
//! cada e no máximo um na fila (AppSec r34 B1': `sync_channel(1)` + `try_send`): uma para as
//! consultas (`spell_check`, `spell_suggest`) e uma para os parses e a sugestão de prova. Fila
//! ocupada → o pedido responde na hora (`TIMEOUT`, ou o par fica de fora), e o trabalho recusado sai
//! com o que carregava. Quem pede mede o prazo e, estourado, responde sem esperar mais; o spellbook
//! não é interrompível dentro de uma palavra, de uma sugestão nem de um parse, então a thread
//! termina esse cálculo e larga o resto do trabalho. Um trabalho leva só referências fracas aos
//! pares (o motor trocado numa recarga sai da memória; só o par em consulta espera o fim do cálculo
//! dele), e a thread das consultas registra o par em consulta (`Holder`): é ele que um estouro
//! desliga. A base e os termos, conferidos na thread de quem pede, nunca esperam pelos pares.
//!
//! Par não confiável (D-R34-4), antes do parse: linha até 4 KiB; `.dic` até 1.000.000 de linhas,
//! nenhuma palavra mais de 16 vezes (AppSec r34 B2) e a contagem da 1ª linha, que o spellbook usa
//! para reservar memória, trocada pelo número real (D-R34-8); recusa compostos (`COMPOUND*`,
//! `CHECKCOMPOUND*`, `ONLYINCOMPOUND`), `CIRCUMFIX`, `COMPLEXPREFIXES` e `AF` (D-R34-7: cada alias
//! é copiado para cada linha do `.dic`, memória multiplicada); ignora o `BREAK` (recursivo: o par
//! roda com `BREAK 0`); até 1.000 PFX, 60.000 SFX, 100 deles com continuação, condição até 256
//! bytes, 64 MAP, 5.000 REP, 1.000 ICONV, 1.000 OCONV e 100.000 regras de afixo visitadas por
//! palavra no pior caso (AppSec r34 B1); `tira` e `põe` de afixo até 64 caracteres, troca de
//! `ICONV`/`OCONV` até 8 (o spellbook mede a palavra antes do `ICONV`), `TRY` e `KEY` até 128 e
//! troca de `REP` até 16 (AppSec r34 B1'). O parse tem prazo (2 s por par, 10 s por recarga) e o
//! par passa por um teste de velocidade — as 128 palavras fixas até 20× o tempo da base (os pares
//! juntos até 40×), cada palavra de prova gerada do próprio par (as cadeias de `add` e os padrões
//! do `ICONV`) até 20× a palavra média da base, com piso de 1 ms, e uma sugestão de prova, na mais
//! lenta delas, até 20× a da base na mesma palavra (no máximo 3 s) —, senão fica de fora (`SLOW`).
//! Nada disso vai ao webview além de `skipped`.
//!
//! Nada sai pela rede: só cálculo e a leitura das camadas (o `check:security` reprova `reqwest`,
//! `std::net`, sockets, `tokio::net`, `tauri_plugin_http`, `crate::ai`, `crate::languagetool` e
//! `://` no código daqui). Logs: uma linha por pedido, com o código, o tempo e contagens; nunca
//! palavra, nome de arquivo ou caminho. Um pânico do spellbook vira `IO` (numa consulta) ou, no
//! parse de um par, a recusa do par.

use std::borrow::Cow;
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::hint::black_box;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, LazyLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use icu_normalizer::properties::CanonicalCombiningClassMapBorrowed;
use icu_normalizer::DecomposingNormalizerBorrowed;
use parking_lot::Mutex;
use serde::Serialize;
use spellbook::Dictionary;
use tauri::State;

use crate::error::AppError;
use crate::vault::dictionaries::{checkable_word, nfc_owned, EnginePair, GlobalDictionaries};
use crate::vault::{blocking, VaultState};

/// O pt_BR do VERO (D-R34-1, D-R34-2): `pt_BR.aff` sha256 `21d8ad2a…3865`, `pt_BR.dic` sha256
/// `a38bfb26…3183` (o `gen-third-party-licenses` reprova outros bytes).
const BASE_AFF: &str = include_str!("../../dictionaries/pt_BR.aff");
const BASE_DIC: &str = include_str!("../../dictionaries/pt_BR.dic");

/// As línguas com dicionário (D-P26-03): só o pt-BR.
const LANGS: &[&str] = &["pt-BR"];
/// Palavras por `spell_check` (design-r34 §1).
const MAX_WORDS: usize = 20_000;
/// Sugestões por `spell_suggest`.
const MAX_SUGGESTIONS: usize = 5;
/// Caracteres de um termo v1 (r32): o maior que chega ao motor e a maior sugestão que sai dele
/// (AppSec r34 N1).
const TERM_MAX_CHARS: usize = 64;
/// Linha de um `.aff` ou `.dic` de par (D-R34-4).
const LINE_MAX_BYTES: usize = 4 * 1024;
/// Linhas de um `.dic` de par (D-R34-4).
const DIC_MAX_LINES: usize = 1_000_000;
/// Vezes que a mesma palavra pode aparecer no `.dic` de um par (AppSec r34 B2): o spellbook guarda
/// as repetidas no mesmo hash, e o parse e a consulta delas ficam quadráticos. O pt_BR repete uma
/// palavra até 4 vezes.
const DIC_REPEAT_MAX: u32 = 16;
/// Regras de um `.aff` de par (D-R34-4; o pt_BR tem 116 PFX, 25.713 SFX, 26 com continuação e 6
/// MAP).
const PFX_MAX: usize = 1_000;
const SFX_MAX: usize = 60_000;
const CONTINUATION_MAX: usize = 100;
const CONDITION_MAX_BYTES: usize = 256;
const MAP_MAX: usize = 64;
const REP_MAX: usize = 5_000;
const CONV_MAX: usize = 1_000;
/// Troca de uma linha `ICONV`/`OCONV` de par (AppSec r34 B1'): o spellbook mede a palavra (360
/// bytes) ANTES do `ICONV`, e cada caractere convertido vira até 8 — 64 caracteres, até 512.
const CONV_TO_MAX_CHARS: usize = 8;
/// `tira` e `põe` de uma regra PFX/SFX de par (AppSec r34 B1'; o pt_BR: até 7 e 15).
const AFFIX_MAX_CHARS: usize = 64;
/// As letras do `TRY` (a sugestão por edição tenta cada uma em cada posição) e o `KEY` de um par
/// (AppSec r34 B1', a5; o pt_BR: 40 no `TRY`, sem `KEY`).
const TRY_MAX_CHARS: usize = 128;
/// Troca de uma linha `REP` de par (AppSec r34 B1'; o pt_BR: até 13).
const REP_TO_MAX_CHARS: usize = 16;
/// Regras de afixo que o spellbook visita, no pior caso, para conferir uma palavra com o `.aff` de
/// um par (AppSec r34 B1; `Shape::work`). O pt_BR embutido: 5.798.
const AFFIX_WORK_MAX: u64 = 100_000;
/// Teste de velocidade de um par (D-R34-4): até 20× o tempo da base; os pares juntos até 40×.
const PAIR_SLOWDOWN: u32 = 20;
const PAIRS_SLOWDOWN: u32 = 40;
/// De quanto em quanto tempo quem espera um trabalho de par confere se o pedido ainda é o mais novo.
const POLL: Duration = Duration::from_millis(25);
/// Palavras do teste de velocidade: cada uma em minúsculas, Título, MAIÚSCULAS e com um erro (128).
const CALIBRATION: [&str; 32] = [
    "casa",
    "exceção",
    "paralelepípedo",
    "computador",
    "ação",
    "água",
    "pássaro",
    "cidadãos",
    "irmã",
    "inconstitucionalmente",
    "desenvolvimento",
    "pôr",
    "têm",
    "vovô",
    "saúde",
    "árvores",
    "três",
    "português",
    "bem-vindo",
    "quinta-feira",
    "hífen",
    "pinguim",
    "frequência",
    "ideia",
    "voo",
    "colecistectomia",
    "anestésicos",
    "farmacêutica",
    "abacaxis",
    "zangão",
    "xícaras",
    "útil",
];

/// Prazos (D-R34-4). Os testes passam outros.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// Um `spell_check` (e a parte dos pares de um `spell_suggest`): estourou → o par que segurava
    /// a thread desligado. Também o teto da sugestão de prova de um par.
    check: Duration,
    /// O parse de um par.
    pair_parse: Duration,
    /// O parse de todos os pares de uma recarga (o que sobra dele também limita o de cada par).
    reload_parse: Duration,
    /// Piso de cada medida do teste de velocidade de um par (o dos pares juntos é o dobro).
    calibration_floor: Duration,
    /// Piso de cada palavra de prova de um par, medida uma a uma (AppSec r34 c1 B1'; em release a
    /// base confere uma palavra em microssegundos).
    probe_floor: Duration,
}

const LIMITS: Limits = Limits {
    check: Duration::from_secs(3),
    pair_parse: Duration::from_secs(2),
    reload_parse: Duration::from_secs(10),
    calibration_floor: Duration::from_millis(5),
    probe_floor: Duration::from_millis(1),
};

/// A base, carregada uma vez por processo no primeiro pedido (~29 MiB; ~50 ms em release).
struct Base {
    dictionary: Dictionary,
    /// A linha `TRY` da base: as letras das sugestões por edição no dicionário dos termos.
    try_chars: String,
}

static BASE: LazyLock<Result<Base, ()>> = LazyLock::new(|| load_base(BASE_AFF, BASE_DIC));

fn base() -> Result<&'static Base, AppError> {
    BASE.as_ref()
        .map_err(|_| AppError::new("SPELL_UNAVAILABLE"))
}

fn load_base(aff: &str, dic: &str) -> Result<Base, ()> {
    let dictionary = Dictionary::new(aff, dic).map_err(|_| ())?;
    let try_chars = aff
        .lines()
        .find_map(|line| line.strip_prefix("TRY "))
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(Base {
        dictionary,
        try_chars,
    })
}

/// As camadas do usuário de uma recarga, trocadas inteiras (`Arc`): os termos `.txt` e os pares.
#[derive(Default)]
struct Engine {
    terms: Option<Dictionary>,
    /// Na ordem das camadas: os da global antes dos da pasta.
    pairs: Vec<Arc<Pair>>,
}

impl Engine {
    /// A base ou os termos conhecem a palavra (os pares, só na thread das consultas).
    fn knows(&self, base: &Base, word: &str) -> bool {
        base.dictionary.check(word) || self.terms.as_ref().is_some_and(|terms| terms.check(word))
    }

    /// Há pares ligados para consultar.
    fn pairs_on(&self) -> bool {
        self.pairs.iter().any(|pair| pair.on())
    }

    /// Os pares ligados para um trabalho na thread das consultas, por referência fraca: o trabalho
    /// (na fila ou preso numa palavra) não segura o motor depois de uma recarga (AppSec r34 B1').
    fn pairs_for_job(&self) -> Vec<Weak<Pair>> {
        self.pairs
            .iter()
            .filter(|pair| pair.on())
            .map(Arc::downgrade)
            .collect()
    }
}

/// Um par carregado e o interruptor dele: desligado por estouro de prazo (D-R34-4) até a próxima
/// recarga, sem levar junto os outros pares, nem os da outra camada (AppSec r34 B1').
struct Pair {
    dictionary: Dictionary,
    off: AtomicBool,
}

impl Pair {
    fn new(dictionary: Dictionary) -> Arc<Self> {
        Arc::new(Self {
            dictionary,
            off: AtomicBool::new(false),
        })
    }

    fn on(&self) -> bool {
        !self.off.load(Ordering::SeqCst)
    }
}

/// O par que a thread das consultas está consultando e desde quando (AppSec r34 B1'): o spellbook
/// não interrompe uma palavra nem uma sugestão, e é esse par que segura a thread quando um pedido
/// fica sem resposta.
#[derive(Default)]
struct Holder(Mutex<Option<(Weak<Pair>, Instant)>>);

impl Holder {
    /// `look` com `pair` registrado como o par em consulta (o registro sai também num pânico).
    fn consult<T>(&self, pair: &Arc<Pair>, look: impl FnOnce() -> T) -> T {
        struct Done<'a>(&'a Holder);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                *self.0 .0.lock() = None;
            }
        }
        *self.0.lock() = Some((Arc::downgrade(pair), Instant::now()));
        let _done = Done(self);
        look()
    }

    /// Desliga o par em consulta: o pedido esperou por ele até o prazo (`waited`), ou ele já segura
    /// a thread há `limit` ou mais. Os outros pares seguem ligados.
    fn blame(&self, waited: bool, limit: Duration) {
        let held = self.0.lock().clone();
        if let Some((pair, since)) = held {
            if waited || since.elapsed() >= limit {
                if let Some(pair) = pair.upgrade() {
                    pair.off.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}

/// Um trabalho para a thread de um `Worker`.
type Job = Box<dyn FnOnce() + Send>;

/// Por que um trabalho com par ficou sem resposta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// O prazo passou (ou já tinha passado: nada entrou na fila).
    Late,
    /// A fila (de um) estava ocupada: nada entrou nela (AppSec r34 B1').
    Busy,
    /// Um pedido mais novo chegou.
    Superseded,
    /// A thread não nasceu ou o trabalho entrou em pânico.
    Broken,
}

/// Uma thread dedicada aos trabalhos com par (não confiável), um por vez, com fila de um (AppSec
/// r34 B1/B2/B1'): ocupada a fila, o trabalho volta na hora (`Busy`) e sai com o que carregava, sem
/// nada acumular atrás de um cálculo preso. Nasce no primeiro uso; um pânico num trabalho não a
/// derruba (quem espera recebe `Broken`). Quem chama mede o prazo (`call`).
struct Worker {
    name: &'static str,
    queue: Mutex<Option<SyncSender<Job>>>,
    /// Threads criadas: uma, salvo se a anterior morreu.
    spawned: AtomicUsize,
}

impl Worker {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            queue: Mutex::new(None),
            spawned: AtomicUsize::new(0),
        }
    }

    /// Põe `job` na fila e espera a resposta até `deadline`, conferindo `superseded` a cada 25 ms.
    /// Prazo já vencido → `Late` sem enfileirar nada (nenhuma thread nasce); fila ocupada → `Busy`,
    /// na hora; sem resposta a tempo → `Late`; pedido mais novo → `Superseded`. Quando `call` volta,
    /// o trabalho fica abandonado (o `&AtomicBool` que ele recebe): a thread termina o cálculo em
    /// curso e larga o resto ao conferir a marca.
    fn call<T: Send + 'static>(
        &self,
        deadline: Instant,
        superseded: impl Fn() -> bool,
        job: impl FnOnce(&AtomicBool) -> T + Send + 'static,
    ) -> Result<T, Stop> {
        if Instant::now() >= deadline {
            return Err(Stop::Late);
        }
        let abandoned = Arc::new(AtomicBool::new(false));
        let _abandon = Abandon(Arc::clone(&abandoned));
        let (reply, answer) = sync_channel(1);
        self.send(Box::new(move || {
            let _ = reply.send(job(&abandoned));
        }))?;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(Stop::Late);
            }
            match answer.recv_timeout((deadline - now).min(POLL)) {
                Ok(value) => return Ok(value),
                Err(RecvTimeoutError::Disconnected) => return Err(Stop::Broken),
                Err(RecvTimeoutError::Timeout) if superseded() => return Err(Stop::Superseded),
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    /// Entrega `job` à fila (de um) da thread, criando-a se ainda não existe (ou se morreu: não
    /// devia, o pânico de um trabalho não a derruba). Fila ocupada → `Busy`, e o `job` sai aqui.
    fn send(&self, job: Job) -> Result<(), Stop> {
        let mut queue = self.queue.lock();
        let job = match &*queue {
            Some(sender) => match sender.try_send(job) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Full(job)) => {
                    // Fora da trava: a sugestão de prova leva o dicionário do par.
                    drop(queue);
                    drop(job);
                    return Err(Stop::Busy);
                }
                Err(TrySendError::Disconnected(job)) => job,
            },
            None => job,
        };
        let (sender, receiver) = sync_channel::<Job>(1);
        thread::Builder::new()
            .name(self.name.to_owned())
            .spawn(move || {
                for job in receiver {
                    // Um pânico do spellbook não derruba a thread: a resposta do trabalho sai junto
                    // e quem espera recebe `Broken`.
                    let _ = panic::catch_unwind(AssertUnwindSafe(job));
                }
            })
            .map_err(|_| Stop::Broken)?;
        self.spawned.fetch_add(1, Ordering::SeqCst);
        // A thread acabou de nascer com o outro lado do canal, e a fila está vazia: cabe.
        let _ = sender.try_send(job);
        *queue = Some(sender);
        Ok(())
    }
}

/// Marca o trabalho de um `Worker::call` como abandonado quando quem pediu volta.
struct Abandon(Arc<AtomicBool>);

impl Drop for Abandon {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Estado do corretor (no app, num `Arc`): as camadas da última recarga, as gerações dos pedidos (o
/// mais novo vence; também lidas pelos trabalhos com par) e as duas threads dos pares.
pub struct SpellState {
    engine: Mutex<Arc<Engine>>,
    checks: Arc<AtomicU64>,
    suggestions: Arc<AtomicU64>,
    reloads: Arc<AtomicU64>,
    /// Uma sugestão por vez.
    suggesting: Mutex<()>,
    /// As consultas aos pares (`spell_check`, `spell_suggest`; AppSec r34 B1).
    lookups: Worker,
    /// O par em consulta na thread das consultas (AppSec r34 B1').
    holder: Arc<Holder>,
    /// Os parses dos pares e a sugestão de prova (AppSec r34 B2/B1').
    parses: Worker,
}

impl Default for SpellState {
    fn default() -> Self {
        Self {
            engine: Mutex::default(),
            checks: Arc::default(),
            suggestions: Arc::default(),
            reloads: Arc::default(),
            suggesting: Mutex::default(),
            lookups: Worker::new("spell-pairs"),
            holder: Arc::default(),
            parses: Worker::new("spell-parse"),
        }
    }
}

/// Resposta de `spell_reload`: as línguas, os termos do usuário (sem repetidos), os pares carregados
/// e as fontes deixadas de fora. Nenhum nome nem caminho.
#[derive(Debug, Serialize)]
pub struct Reloaded {
    langs: &'static [&'static str],
    words: u32,
    pairs: u32,
    skipped: u32,
    /// Motivos das recusas de par no motor, só para o log.
    #[serde(skip)]
    refused: Refused,
}

/// Por que o motor deixou um par de fora (contado em `skipped`; nunca vai ao webview).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// Linha acima de 4 KiB, `.dic` acima de 1.000.000 de linhas ou com uma palavra mais de 16
    /// vezes.
    Lines,
    /// Diretiva recusada (composto, circunfixo, prefixos complexos, alias de flags).
    Directive,
    /// Regras demais, condição longa, mais de 100.000 regras visitadas por palavra ou troca longa
    /// (`tira`/`põe` de afixo, `ICONV`/`OCONV`, `REP`, `TRY`/`KEY`; AppSec r34 B1').
    Rules,
    /// O spellbook recusou o par (ou entrou em pânico no parse ou na sugestão de prova).
    Parse,
    /// O parse passou do prazo, ou a thread de parse estava ocupada.
    Timeout,
    /// Reprovou no teste de velocidade (as palavras fixas, as de prova ou a sugestão de prova).
    Slow,
}

/// Contagem das recusas por motivo (para o log).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Refused {
    lines: u32,
    directive: u32,
    rules: u32,
    parse: u32,
    timeout: u32,
    slow: u32,
}

impl Refused {
    fn count(&mut self, refusal: Refusal) {
        let slot = match refusal {
            Refusal::Lines => &mut self.lines,
            Refusal::Directive => &mut self.directive,
            Refusal::Rules => &mut self.rules,
            Refusal::Parse => &mut self.parse,
            Refusal::Timeout => &mut self.timeout,
            Refusal::Slow => &mut self.slow,
        };
        *slot += 1;
    }
}

/// O teste de velocidade de um par (D-R34-4), relativo à base medida na mesma recarga.
#[derive(Debug, Clone, Copy)]
struct Speed {
    /// Para as 128 palavras fixas: até 20× a base (com o piso), no que sobra dos 40× dos pares.
    words: Duration,
    /// Para cada palavra de prova: até 20× a palavra média da base, com o piso dela (AppSec r34
    /// B1/B1': uma por uma, para uma prova lenta não se esconder atrás das rápidas).
    probe: Duration,
    /// O piso de cada medida.
    floor: Duration,
    /// O teto da sugestão de prova: o prazo de uma consulta.
    ceiling: Duration,
}

/// Só `pt-BR` (D-P26-03).
fn lang_ok(lang: &str) -> Result<(), AppError> {
    if LANGS.contains(&lang) {
        Ok(())
    } else {
        Err(AppError::new("UNSUPPORTED_LANG"))
    }
}

/// A língua e o teto de palavras de um `spell_check`, antes da thread de bloqueio. Um pedido
/// recusado aqui não cancela o anterior.
fn admit(lang: &str, words: usize) -> Result<(), AppError> {
    lang_ok(lang)?;
    if words > MAX_WORDS {
        return Err(
            AppError::new("TOO_MANY_WORDS").with_detail(serde_json::json!({ "max": MAX_WORDS }))
        );
    }
    Ok(())
}

fn cancelled() -> AppError {
    AppError::new("CANCELLED")
}

impl SpellState {
    /// A geração de um `spell_check` novo: os anteriores param na próxima palavra.
    fn next_check(&self) -> u64 {
        self.checks.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn next_suggestion(&self) -> u64 {
        self.suggestions.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn next_reload(&self) -> u64 {
        self.reloads.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn engine(&self) -> Arc<Engine> {
        self.engine.lock().clone()
    }

    /// Os índices das palavras fora da base, dos termos e dos pares: a base e os termos aqui, e as
    /// que eles não conhecem vão aos pares na thread das consultas. Para com `CANCELLED` se outro
    /// `spell_check` chegou e com `TIMEOUT` depois de `limit` (`overrun`: desliga o par que segura
    /// a thread).
    fn check(
        &self,
        generation: u64,
        words: &[String],
        limit: Duration,
    ) -> Result<Vec<u32>, AppError> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let base = base()?;
        let engine = self.engine();
        let deadline = Instant::now() + limit;
        let superseded = || self.checks.load(Ordering::SeqCst) != generation;
        let mut unknown = Vec::new();
        let mut asked = Vec::new();
        for (index, word) in words.iter().enumerate() {
            if superseded() {
                return Err(cancelled());
            }
            if Instant::now() >= deadline {
                // Os pares nem foram consultados: nenhum desliga.
                return Err(timeout(limit));
            }
            if let Some(word) = checkable_word(word) {
                if !engine.knows(base, &word) {
                    unknown.push(index as u32);
                    asked.push(word.into_owned());
                }
            }
        }
        if asked.is_empty() || !engine.pairs_on() {
            return Ok(unknown);
        }
        let job = {
            let pairs = engine.pairs_for_job();
            let (checks, holder) = (Arc::clone(&self.checks), Arc::clone(&self.holder));
            move |abandoned: &AtomicBool| {
                let stop = || {
                    abandoned.load(Ordering::SeqCst) || checks.load(Ordering::SeqCst) != generation
                };
                let mut known = Vec::new();
                for (at, word) in asked.iter().enumerate() {
                    for pair in &pairs {
                        if stop() {
                            return None;
                        }
                        let pair = pair.upgrade()?;
                        if pair.on() && holder.consult(&pair, || pair.dictionary.check(word)) {
                            known.push(at);
                            break;
                        }
                    }
                }
                Some(known)
            }
        };
        match self.lookups.call(deadline, superseded, job) {
            Ok(Some(known)) => {
                let mut known = known.into_iter().peekable();
                Ok(unknown
                    .into_iter()
                    .enumerate()
                    .filter_map(|(at, index)| known.next_if_eq(&at).is_none().then_some(index))
                    .collect())
            }
            // O trabalho só larga sem resposta, com alguém esperando, se um pedido mais novo chegou.
            Ok(None) => Err(self.overrun(Stop::Superseded, superseded(), limit)),
            Err(stop) => Err(self.overrun(stop, superseded(), limit)),
        }
    }

    /// Até 5 sugestões (D-R34-6): as edições da base, dos termos e dos pares (na thread das
    /// consultas), nessa ordem; o n-grama da base (que relê a lista inteira) só se nenhuma edição
    /// trouxer palavra única; palavra única antes de forma com espaço; sem repetidas e só as que
    /// podem sair (`presentable`). Uma por vez; um pedido mais novo → `CANCELLED`; a parte dos pares
    /// passou de `limit` → `TIMEOUT` (`overrun`: desliga o par que segura a thread).
    fn suggest(
        &self,
        generation: u64,
        word: &str,
        limit: Duration,
    ) -> Result<Vec<String>, AppError> {
        let base = base()?;
        let _one = self.suggesting.lock();
        let superseded = || self.suggestions.load(Ordering::SeqCst) != generation;
        if superseded() {
            return Err(cancelled());
        }
        let Some(word) = checkable_word(word) else {
            return Ok(Vec::new());
        };
        let word = word.into_owned();
        let engine = self.engine();
        let mut found = Vec::new();
        let mut batch = Vec::new();
        edits(&base.dictionary, &word, &mut batch);
        merge(&mut found, &mut batch, &word);
        if let Some(terms) = &engine.terms {
            edits(terms, &word, &mut batch);
            merge(&mut found, &mut batch, &word);
        }
        if engine.pairs_on() {
            let deadline = Instant::now() + limit;
            let job = {
                let pairs = engine.pairs_for_job();
                let (suggestions, holder) =
                    (Arc::clone(&self.suggestions), Arc::clone(&self.holder));
                let word = word.clone();
                move |abandoned: &AtomicBool| {
                    let mut found = Vec::new();
                    for pair in &pairs {
                        if abandoned.load(Ordering::SeqCst)
                            || suggestions.load(Ordering::SeqCst) != generation
                        {
                            return None;
                        }
                        let pair = pair.upgrade()?;
                        if pair.on() {
                            let mut batch = Vec::new();
                            holder.consult(&pair, || edits(&pair.dictionary, &word, &mut batch));
                            found.append(&mut batch);
                        }
                    }
                    Some(found)
                }
            };
            match self.lookups.call(deadline, superseded, job) {
                Ok(Some(mut from_pairs)) => merge(&mut found, &mut from_pairs, &word),
                Ok(None) => return Err(self.overrun(Stop::Superseded, superseded(), limit)),
                Err(stop) => return Err(self.overrun(stop, superseded(), limit)),
            }
        }
        if found.iter().all(|s| s.contains(' ')) {
            base.dictionary.suggest(&word, &mut batch);
            merge(&mut found, &mut batch, &word);
        }
        if superseded() {
            return Err(cancelled());
        }
        let (mut single, spaced): (Vec<String>, Vec<String>) =
            found.into_iter().partition(|s| !s.contains(' '));
        single.extend(spaced);
        single.truncate(MAX_SUGGESTIONS);
        Ok(single)
    }

    /// Um pedido que ficou sem a resposta dos pares: pedido mais novo → `CANCELLED`; pânico → `IO`;
    /// senão `TIMEOUT { seconds }`, e o par que segura a thread das consultas desliga até a próxima
    /// recarga (AppSec r34 B1') — se este pedido esperou por ele até o prazo (`Late`), ou, com a
    /// fila ocupada (`Busy`), se ele já segura a thread há `limit` ou mais. Os outros pares, também
    /// os da outra camada, seguem ligados.
    fn overrun(&self, stop: Stop, superseded: bool, limit: Duration) -> AppError {
        match stop {
            Stop::Broken => AppError::new("IO"),
            Stop::Superseded => cancelled(),
            _ if superseded => cancelled(),
            Stop::Late | Stop::Busy => {
                self.holder.blame(stop == Stop::Late, limit);
                timeout(limit)
            }
        }
    }

    /// `spell_reload` com o token já recebido: a raiz da pasta (`VaultState::root`, o primeiro uso
    /// de uma pendente a ativa) e a recarga.
    fn reload_for(
        &self,
        ticket: u64,
        global: &GlobalDictionaries,
        vault: &VaultState,
        token: Option<u32>,
        limits: Limits,
    ) -> Result<Reloaded, AppError> {
        let folder = token.map(|token| vault.root(token)).transpose()?;
        self.reload(ticket, global, folder.as_deref(), limits)
    }

    /// Relê as camadas (`engine_sources`), monta o dicionário dos termos, carrega os pares que
    /// passam (D-R34-4) e troca tudo de uma vez — se nenhuma recarga mais nova chegou.
    fn reload(
        &self,
        ticket: u64,
        global: &GlobalDictionaries,
        folder: Option<&Path>,
        limits: Limits,
    ) -> Result<Reloaded, AppError> {
        let base = base()?;
        self.still(ticket)?;
        let sources = global.engine_sources(folder);
        let words = sources.terms.len() as u32;
        let terms = terms_dictionary(base, &sources.terms)?;
        drop(sources.terms);
        let mut skipped = sources.skipped;
        let mut refused = Refused::default();
        // Teste de velocidade relativo à base, medido agora (mesma máquina, mesma carga).
        let base_time =
            timed(&base.dictionary, &CALIBRATION_WORDS, Duration::MAX).unwrap_or_default();
        let per_word = base_time / CALIBRATION_WORDS.len() as u32;
        let speed = Speed {
            words: (base_time * PAIR_SLOWDOWN).max(limits.calibration_floor),
            probe: (per_word * PAIR_SLOWDOWN).max(limits.probe_floor),
            floor: limits.calibration_floor,
            ceiling: limits.check,
        };
        let mut pairs_left = (base_time * PAIRS_SLOWDOWN).max(limits.calibration_floor * 2);
        let parse_until = Instant::now() + limits.reload_parse;
        let mut pairs = Vec::new();
        for pair in sources.pairs {
            self.still(ticket)?;
            let parse = limits
                .pair_parse
                .min(parse_until.saturating_duration_since(Instant::now()));
            let speed = Speed {
                words: speed.words.min(pairs_left),
                ..speed
            };
            match self.load_pair(ticket, base, pair, parse, speed) {
                Ok((dictionary, time)) => {
                    pairs_left = pairs_left.saturating_sub(time);
                    pairs.push(Pair::new(dictionary));
                }
                Err(refusal) => {
                    skipped += 1;
                    refused.count(refusal);
                }
            }
        }
        let reloaded = Reloaded {
            langs: LANGS,
            words,
            pairs: pairs.len() as u32,
            skipped,
            refused,
        };
        self.install(ticket, Engine { terms, pairs })?;
        Ok(reloaded)
    }

    /// Carrega um par não confiável (D-R34-4): confere o `.aff` e o `.dic`, roda com `BREAK 0` (o
    /// `BREAK` dele é ignorado), faz o parse na thread de parse, com `parse` contado do começo dele,
    /// e passa no teste de velocidade (`speed`): as 128 palavras fixas, cada prova do par e a
    /// sugestão de prova (AppSec r34 c1 B1'), na prova mais lenta, até 20× a da base na mesma
    /// palavra (entre o piso e o prazo de uma consulta). Devolve o dicionário e o tempo das
    /// palavras fixas.
    fn load_pair(
        &self,
        ticket: u64,
        base: &Base,
        pair: EnginePair,
        parse: Duration,
        speed: Speed,
    ) -> Result<(Dictionary, Duration), Refusal> {
        let vetted = vet_aff(&pair.aff)?;
        let dic = prepare_dic(&pair.dic, &vetted.ignore)?;
        drop(pair.dic);
        let mut aff = pair.aff;
        aff.push_str("\nBREAK 0\n");
        let dictionary = self.parse_within(ticket, aff, dic, Instant::now() + parse)?;
        let time = timed(&dictionary, &CALIBRATION_WORDS, speed.words).ok_or(Refusal::Slow)?;
        let slowest =
            slowest_probe(&dictionary, &vetted.probes, speed.probe).ok_or(Refusal::Slow)?;
        let word = vetted.probes.get(slowest).cloned().unwrap_or_default();
        let started = Instant::now();
        edits(&base.dictionary, &word, &mut Vec::new());
        let suggestion = (started.elapsed() * PAIR_SLOWDOWN)
            .max(speed.floor)
            .min(speed.ceiling);
        let dictionary =
            self.suggest_within(ticket, dictionary, word, Instant::now() + suggestion)?;
        Ok((dictionary, time))
    }

    /// O parse de um par na thread de parse, até `deadline` (AppSec r34 B2): prazo já vencido →
    /// `Timeout` sem enfileirar nada (nenhuma thread nasce); fila ocupada → `Timeout` na hora;
    /// estourado → `Timeout`, e o resultado é descartado quando sai (o spellbook não é
    /// interrompível; os tetos e as repetições do `.dic` limitam o trabalho). Na fila, o parse
    /// abandonado ou de uma recarga vencida é pulado. Pânico ou par recusado pelo spellbook →
    /// `Parse`.
    fn parse_within(
        &self,
        ticket: u64,
        aff: String,
        dic: String,
        deadline: Instant,
    ) -> Result<Dictionary, Refusal> {
        let reloads = Arc::clone(&self.reloads);
        let job = move |abandoned: &AtomicBool| {
            if abandoned.load(Ordering::SeqCst) || reloads.load(Ordering::SeqCst) != ticket {
                return None;
            }
            Some(Dictionary::new(&aff, &dic).ok())
        };
        let superseded = || self.reloads.load(Ordering::SeqCst) != ticket;
        match self.parses.call(deadline, superseded, job) {
            Ok(Some(Some(dictionary))) => Ok(dictionary),
            Ok(Some(None)) | Err(Stop::Broken) => Err(Refusal::Parse),
            Ok(None) | Err(Stop::Late | Stop::Busy | Stop::Superseded) => Err(Refusal::Timeout),
        }
    }

    /// A sugestão de prova de um par na thread de parse, até `deadline` (AppSec r34 B1'): o
    /// spellbook não interrompe uma sugestão, e a recarga não espera além do prazo. Estourada →
    /// `Slow`, e a thread termina essa sugestão antes do próximo trabalho dela (fila ocupada →
    /// `Timeout`); pânico → `Parse`. Passou → o dicionário de volta.
    fn suggest_within(
        &self,
        ticket: u64,
        dictionary: Dictionary,
        word: String,
        deadline: Instant,
    ) -> Result<Dictionary, Refusal> {
        let reloads = Arc::clone(&self.reloads);
        let job = move |abandoned: &AtomicBool| {
            if abandoned.load(Ordering::SeqCst) || reloads.load(Ordering::SeqCst) != ticket {
                return None;
            }
            edits(&dictionary, &word, &mut Vec::new());
            Some(dictionary)
        };
        let superseded = || self.reloads.load(Ordering::SeqCst) != ticket;
        match self.parses.call(deadline, superseded, job) {
            Ok(Some(dictionary)) => Ok(dictionary),
            Err(Stop::Broken) => Err(Refusal::Parse),
            Err(Stop::Busy) => Err(Refusal::Timeout),
            Ok(None) | Err(Stop::Late | Stop::Superseded) => Err(Refusal::Slow),
        }
    }

    /// Troca as camadas por `engine` se esta recarga ainda é a mais nova, conferido sob a trava:
    /// uma recarga mais nova que chegou durante o parse não é desfeita por esta (`CANCELLED`). As
    /// camadas anteriores (dezenas de MiB) saem fora da trava.
    fn install(&self, ticket: u64, engine: Engine) -> Result<(), AppError> {
        let mut slot = self.engine.lock();
        self.still(ticket)?;
        let previous = std::mem::replace(&mut *slot, Arc::new(engine));
        drop(slot);
        drop(previous);
        Ok(())
    }

    /// Esta recarga ainda é a mais nova.
    fn still(&self, ticket: u64) -> Result<(), AppError> {
        if self.reloads.load(Ordering::SeqCst) == ticket {
            Ok(())
        } else {
            Err(cancelled())
        }
    }
}

fn timeout(limit: Duration) -> AppError {
    AppError::new("TIMEOUT").with_detail(serde_json::json!({ "seconds": limit.as_secs() }))
}

/// As sugestões por edição de `dictionary` em `batch` (sem o n-grama, que relê a lista inteira).
fn edits(dictionary: &Dictionary, word: &str, batch: &mut Vec<String>) {
    dictionary
        .suggester()
        .with_ngram_suggestions(false)
        .suggest(word, batch);
}

/// Junta a `found` as sugestões de `batch` (esvaziado) para `word` que podem sair, sem repetidas,
/// na ordem.
fn merge(found: &mut Vec<String>, batch: &mut Vec<String>, word: &str) {
    for suggestion in batch.drain(..) {
        if let Some(suggestion) = presentable(suggestion, word) {
            if !found.contains(&suggestion) {
                found.push(suggestion);
            }
        }
    }
}

/// Sintaxe que uma sugestão só traz se a palavra pedida também a tiver (AppSec r34 N1'): entidade
/// (`&lt;`), atributo (`"`), código (`` ` ``, `${}`), link e imagem do Markdown (`[…](…)`).
const SYNTAX: [char; 8] = ['&', '"', '`', '$', '[', ']', '(', ')'];

/// Uma sugestão para `word` que pode ir ao webview, em NFC (AppSec r34 N1/N1': o `OCONV` e o `REP`
/// de um par escrevem o que quiserem na saída): até 64 caracteres; cada parte entre espaços
/// simples um termo inteiro (`checkable_word`: sem outro espaço, Cc nem Cf); sem `<` nem `>`; sem
/// a `SYNTAX` que `word` não tem; sem uso privado nem invisível (`hidden`); no máximo 2 marcas
/// combinantes empilhadas; e nenhuma parte com letra latina junto de cirílica ou grega (o
/// homóglifo `p\u{430}ypal`, com o a cirílico U+0430). Fora disso, descartada.
fn presentable(suggestion: String, word: &str) -> Option<String> {
    let suggestion = nfc_owned(suggestion);
    let shown = suggestion.chars().count() <= TERM_MAX_CHARS
        && !suggestion.chars().any(|c| {
            matches!(c, '<' | '>') || (SYNTAX.contains(&c) && !word.contains(c)) || hidden(c)
        })
        && stacked_marks(&suggestion) <= 2
        && suggestion
            .split(' ')
            .all(|part| checkable_word(part).is_some() && !mixed_script(part));
    shown.then_some(suggestion)
}

/// Uso privado (sem glifo padrão) e os `Default_Ignorable_Code_Point` fora de `Cf` (que o
/// `checkable_word` já recusa): o CGJ, as vogais inerentes do khmer, os seletores de variação
/// (também os do mongol) e os preenchedores Hangul (U+115F, U+1160, U+3164, U+FFA0). Somem na tela.
fn hidden(c: char) -> bool {
    matches!(
        c,
        '\u{034F}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{3164}'
            | '\u{E000}'..='\u{F8FF}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}'
            | '\u{E0000}'..='\u{E0FFF}'
            | '\u{F0000}'..='\u{10FFFF}'
    )
}

/// A maior sequência de marcas combinantes (classe canônica não zero) na forma decomposta (NFD):
/// o português usa uma, o vietnamita até duas; um texto "zalgo" empilha dezenas.
fn stacked_marks(text: &str) -> usize {
    let classes = CanonicalCombiningClassMapBorrowed::new();
    let (mut run, mut most) = (0, 0);
    for c in DecomposingNormalizerBorrowed::new_nfd().normalize_iter(text.chars()) {
        run = if classes.get_u8(c) == 0 { 0 } else { run + 1 };
        most = most.max(run);
    }
    most
}

/// Letra latina junto de cirílica ou grega na mesma palavra.
fn mixed_script(word: &str) -> bool {
    word.chars().any(latin) && word.chars().any(greek_or_cyrillic)
}

/// Letra do alfabeto latino: ASCII, `ª`/`º`, Latin-1, Latin Extended-A/B, IPA e os blocos Latin
/// Extended Additional, C, D e E, as ligaduras (`ﬁ`) e as de largura total.
fn latin(c: char) -> bool {
    c.is_ascii_alphabetic()
        || matches!(
            c,
            'ª' | 'º'
                | 'À'..='Ö'
                | 'Ø'..='ö'
                | 'ø'..='ʯ'
                | '\u{1D00}'..='\u{1D25}'
                | '\u{1E00}'..='\u{1EFF}'
                | '\u{2C60}'..='\u{2C7F}'
                | '\u{A722}'..='\u{A7FF}'
                | '\u{AB30}'..='\u{AB5A}'
                | '\u{FB00}'..='\u{FB06}'
                | '\u{FF21}'..='\u{FF3A}'
                | '\u{FF41}'..='\u{FF5A}'
        )
}

/// Letra grega (com o copta do bloco) ou cirílica, nos blocos delas.
fn greek_or_cyrillic(c: char) -> bool {
    matches!(
        c,
        '\u{0370}'..='\u{03FF}'
            | '\u{0400}'..='\u{052F}'
            | '\u{1C80}'..='\u{1C8F}'
            | '\u{1D26}'..='\u{1D2A}'
            | '\u{1F00}'..='\u{1FFF}'
            | '\u{2DE0}'..='\u{2DFF}'
            | '\u{A640}'..='\u{A69F}'
            | '\u{AB65}'
            | '\u{1E030}'..='\u{1E08F}'
    )
}

/// O dicionário dos termos `.txt` das camadas (design-r34 §1): `SET UTF-8` + o `TRY` da base (as
/// letras das sugestões por edição) e uma palavra por linha, sem flags (`/` vira `\/`, o separador
/// delas). A palavra em minúsculas vale também em Título e MAIÚSCULAS, como no Hunspell; e, num
/// dicionário à parte, vence o `FORBIDDENWORD` da base. Sem termos → `None`.
fn terms_dictionary(base: &Base, terms: &[String]) -> Result<Option<Dictionary>, AppError> {
    if terms.is_empty() {
        return Ok(None);
    }
    let aff = format!("SET UTF-8\nTRY {}\n", base.try_chars);
    let mut dic = String::with_capacity(terms.iter().map(|term| term.len() + 2).sum::<usize>() + 8);
    dic.push_str(&terms.len().to_string());
    dic.push('\n');
    for term in terms {
        dic.push_str(&term.replace('/', "\\/"));
        dic.push('\n');
    }
    Dictionary::new(&aff, &dic)
        .map(Some)
        .map_err(|_| AppError::new("IO"))
}

/// O `.dic` de um par pronto para o parse: até 1.000.000 de linhas de até 4 KiB, nenhuma palavra
/// mais de 16 vezes (`repeats`) e a contagem da 1ª linha (com que o spellbook reserva até 2^20
/// entradas, ~33 MiB; D-R34-8) trocada pelo número de linhas que existem. Linhas demais, longas ou
/// repetidas → `Lines`; sem contagem válida → `Parse` (o spellbook também recusaria).
fn prepare_dic(dic: &str, ignore: &[char]) -> Result<String, Refusal> {
    let body = dic.strip_prefix('\u{FEFF}').unwrap_or(dic);
    let mut lines = 0usize;
    for line in body.lines() {
        lines += 1;
        if lines > DIC_MAX_LINES || line.len() > LINE_MAX_BYTES {
            return Err(Refusal::Lines);
        }
    }
    // A contagem é a 1ª linha que não é comentário (`#`), como no parser do spellbook.
    let mut rest = body;
    let header = loop {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        rest = after;
        if !line.trim_start().starts_with('#') || rest.is_empty() {
            break line;
        }
    };
    let declared: usize = header
        .split_whitespace()
        .next()
        .and_then(|count| count.parse().ok())
        .ok_or(Refusal::Parse)?;
    repeats(rest, ignore)?;
    Ok(format!("{}\n{rest}", declared.min(lines)))
}

/// Nenhuma palavra das linhas do `.dic` mais de 16 vezes (AppSec r34 B2), contada como o spellbook
/// a guarda (`dic_word`, sem comentário nem os caracteres do `IGNORE`) e com as caixas juntas: a
/// forma em Título que ele acrescenta a uma palavra em MAIÚSCULAS ou mista cai na mesma conta. Só o
/// hash de cada palavra fica na memória. Acima → `Lines`.
fn repeats(lines: &str, ignore: &[char]) -> Result<(), Refusal> {
    let hasher = RandomState::new();
    let mut seen: HashMap<u64, u32> = HashMap::new();
    for line in lines.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        let Some(word) = dic_word(line) else {
            continue;
        };
        let mut state = hasher.build_hasher();
        for c in word
            .chars()
            .filter(|c| !ignore.contains(c))
            .flat_map(char::to_lowercase)
        {
            state.write_u32(u32::from(c));
        }
        let count = seen.entry(state.finish()).or_insert(0);
        *count += 1;
        if *count > DIC_REPEAT_MAX {
            return Err(Refusal::Lines);
        }
    }
    Ok(())
}

/// A palavra de uma linha do `.dic` como o spellbook a guarda (parser.rs:184-213 e 1208-1326):
/// linha aparada; vazia ou começada por `/` (comentário do it_IT) → `None`; até a 1ª `/` não
/// escapada (`\/` vira `/`), o TAB ou o espaço de um campo morfológico (` po:subst`).
fn dic_word(line: &str) -> Option<Cow<'_, str>> {
    let line = line.trim();
    if line.is_empty() || (line.starts_with('/') && line.len() > 1) {
        return None;
    }
    let Some(at) = line.find(['/', '\\', ' ', '\t']) else {
        return Some(Cow::Borrowed(line));
    };
    if (line.as_bytes()[at] == b'/' && at != 0) || line.as_bytes()[at] == b'\t' {
        return Some(Cow::Borrowed(&line[..at]));
    }
    let mut word = String::from(&line[..at]);
    let rest = &line[at..];
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        match c {
            '/' if escaped => {
                word.pop();
                word.push('/');
            }
            '/' if i != 0 => break,
            '\t' => break,
            ' ' if morphological(&rest[i + 1..]) => break,
            _ => word.push(c),
        }
        escaped = c == '\\';
    }
    Some(Cow::Owned(word))
}

/// O que vem depois de um espaço abre um campo morfológico: duas minúsculas e `:` (` po:subst`).
fn morphological(after: &str) -> bool {
    let mut chars = after.trim_start().chars();
    chars.next().is_some_and(char::is_lowercase)
        && chars.next().is_some_and(char::is_lowercase)
        && chars.next() == Some(':')
}

/// Diretivas que o `.aff` de um par não pode ter (D-R34-4): compostos (um `.aff` de 39 B com
/// `COMPOUNDFLAG` e `COMPOUNDMIN 2` levou 12,9 ms numa palavra de 33 letras, 1,4× a mais por letra),
/// circunfixo, prefixos complexos e alias de flags (`AF`, D-R34-7: cada alias é copiado para cada
/// linha do `.dic` que o usa).
fn refused_directive(key: &str) -> bool {
    key.starts_with("COMPOUND")
        || key.starts_with("CHECKCOMPOUND")
        || matches!(
            key,
            "ONLYINCOMPOUND" | "CIRCUMFIX" | "COMPLEXPREFIXES" | "AF"
        )
}

/// Regras contadas no `.aff` de um par.
#[derive(Default)]
struct AffCounts {
    pfx: usize,
    sfx: usize,
    continuation: usize,
    map: usize,
    rep: usize,
    iconv: usize,
    oconv: usize,
}

impl AffCounts {
    /// Uma linha da tabela `key`, depois da diretiva: a contagem e, numa troca, o tamanho dela
    /// (AppSec r34 B1').
    fn row<'a>(
        &mut self,
        key: &str,
        mut words: impl Iterator<Item = &'a str>,
    ) -> Result<(), Refusal> {
        let (count, max) = match key {
            "PFX" => (&mut self.pfx, PFX_MAX),
            "SFX" => (&mut self.sfx, SFX_MAX),
            "MAP" => (&mut self.map, MAP_MAX),
            "REP" => (&mut self.rep, REP_MAX),
            "ICONV" => (&mut self.iconv, CONV_MAX),
            "OCONV" => (&mut self.oconv, CONV_MAX),
            _ => return Ok(()),
        };
        *count += 1;
        if *count > max {
            return Err(Refusal::Rules);
        }
        let longer =
            |text: Option<&str>, most: usize| text.is_some_and(|t| t.chars().count() > most);
        match key {
            "PFX" | "SFX" => {
                // `<flag> <tira> <põe>[/<flags>] [condição]`
                let (strip, add) = (words.nth(1), words.next());
                let (add, flags) = add.map_or((None, ""), |add| {
                    let (add, flags) = add.split_once('/').unwrap_or((add, ""));
                    (Some(add), flags)
                });
                if longer(strip, AFFIX_MAX_CHARS) || longer(add, AFFIX_MAX_CHARS) {
                    return Err(Refusal::Rules);
                }
                if !flags.is_empty() {
                    self.continuation += 1;
                    if self.continuation > CONTINUATION_MAX {
                        return Err(Refusal::Rules);
                    }
                }
                if words
                    .next()
                    .is_some_and(|condition| condition.len() > CONDITION_MAX_BYTES)
                {
                    return Err(Refusal::Rules);
                }
            }
            "ICONV" | "OCONV" | "REP" => {
                // `<de> <para>`
                let most = if key == "REP" {
                    REP_TO_MAX_CHARS
                } else {
                    CONV_TO_MAX_CHARS
                };
                if longer(words.nth(1), most) {
                    return Err(Refusal::Rules);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Como o `.aff` escreve as flags (`FLAG`, parser.rs:1618-1628; sem a diretiva, um byte cada). O
/// spellbook lê cada tabela com o tipo vigente na linha dela, e a conta segue a mesma ordem.
#[derive(Debug, Clone, Copy)]
enum Flags {
    Short,
    Long,
    Numeric,
    Utf8,
}

impl Flags {
    fn named(name: Option<&str>) -> Self {
        match name {
            Some("long") => Self::Long,
            Some("num") => Self::Numeric,
            Some("UTF-8") => Self::Utf8,
            _ => Self::Short,
        }
    }

    /// A flag do cabeçalho de uma tabela PFX/SFX, como o spellbook a guarda (`parse_flag_from_str`,
    /// parser.rs:1070-1104). Malformada → `None` (o parse recusaria o par).
    fn one(self, token: &str) -> Option<u16> {
        match self {
            Self::Short => token.bytes().next().map(u16::from),
            Self::Long => match token.as_bytes() {
                [first, second, ..] => Some(u16::from_ne_bytes([*first, *second])),
                _ => None,
            },
            Self::Numeric => token.parse().ok(),
            Self::Utf8 => token.encode_utf16().next(),
        }
    }

    /// As flags de continuação de uma regra (`parse_flags_from_str`, parser.rs:1107-1175).
    fn each(self, flags: &str, into: &mut HashSet<u16>) {
        match self {
            Self::Short => into.extend(flags.bytes().map(u16::from)),
            Self::Long => {
                let (pairs, _) = flags.as_bytes().as_chunks::<2>();
                into.extend(pairs.iter().map(|pair| u16::from_ne_bytes(*pair)));
            }
            Self::Numeric => {
                into.extend(flags.split(',').filter_map(|flag| flag.parse::<u16>().ok()))
            }
            Self::Utf8 => into.extend(flags.encode_utf16()),
        }
    }
}

/// As regras de afixo de um `.aff` de par como o spellbook as consulta (`AffixIndex::affixes_of`,
/// aff.rs:526-635): uma palavra visita, de cada tabela, toda regra cujo `add` é começo (PFX) ou fim
/// (SFX) dela.
#[derive(Default)]
struct Shape {
    /// A flag e o `add` de cada PFX e de cada SFX.
    prefixes: Vec<(u16, String)>,
    suffixes: Vec<(u16, String)>,
    /// As flags de continuação (depois da `/` do `add`) dos PFX e dos SFX (`all_flags`).
    prefix_continuations: HashSet<u16>,
    suffix_continuations: HashSet<u16>,
    /// Os padrões do `ICONV` (sem o `_` que prende ao fim da palavra) e o tamanho da troca de cada
    /// um, em caracteres (AppSec r34 B1').
    conversions: Vec<(String, usize)>,
}

impl Shape {
    /// Uma linha `<PFX|SFX> <flag> <tira> <põe>[/<flags>]` com a flag do cabeçalho; `0` põe nada.
    fn push(&mut self, table: &str, flag: u16, add: &str, flags: Flags) {
        let (add, continuation) = add.split_once('/').unwrap_or((add, ""));
        let add = if add == "0" { "" } else { add };
        let (rules, continuations) = if table == "PFX" {
            (&mut self.prefixes, &mut self.prefix_continuations)
        } else {
            (&mut self.suffixes, &mut self.suffix_continuations)
        };
        rules.push((flag, add.to_owned()));
        flags.each(continuation, continuations);
    }

    /// Uma linha `ICONV <de> <para>`. Um padrão de mais de 64 caracteres nunca casa com um termo.
    fn convert(&mut self, from: &str, to: &str) {
        let from = from.strip_suffix('_').unwrap_or(from);
        if (1..=TERM_MAX_CHARS).contains(&from.chars().count()) {
            self.conversions.push((from.to_owned(), to.chars().count()));
        }
    }

    /// O pior caso de regras visitadas numa palavra por `check_simple_word` (checker.rs:403-466;
    /// sem `COMPLEXPREFIXES`), com P e S = as maiores cadeias de PFX e de SFX, SO = a dos SFX cuja
    /// flag é continuação de um SFX e SO₂ = de um PFX ou SFX (os outros saem pela faixa rápida, sem
    /// laço interno): só sufixo (S), só prefixo (P), prefixo e sufixo (P + P·S); havendo
    /// continuação de SFX, dois sufixos (S + SO·S) e prefixo e dois sufixos (P + P·S + P·SO·S);
    /// havendo qualquer continuação, sufixo, prefixo e sufixo (S + SO₂·P + SO₂·P·S). Com as palavras
    /// de prova dessas cadeias e do `ICONV` (`probes`).
    fn work(&self, ignore: &[char]) -> (u64, Vec<String>) {
        let suffixes = |keep: &dyn Fn(u16) -> bool| {
            let adds = self.suffixes.iter().filter(|(flag, _)| keep(*flag));
            chain(adds.map(|(_, add)| add.as_str()), true, ignore)
        };
        let p = chain(
            self.prefixes.iter().map(|(_, add)| add.as_str()),
            false,
            ignore,
        );
        let s = suffixes(&|_| true);
        let so = suffixes(&|flag| self.suffix_continuations.contains(&flag));
        let so2 = suffixes(&|flag| {
            self.suffix_continuations.contains(&flag) || self.prefix_continuations.contains(&flag)
        });
        let (pr, sr) = (p.rules, s.rules);
        let mut work = sr + 2 * pr + pr * sr;
        if !self.suffix_continuations.is_empty() {
            work += sr + so.rules * sr + pr + pr * sr + pr * so.rules * sr;
        }
        if !self.suffix_continuations.is_empty() || !self.prefix_continuations.is_empty() {
            work += sr + so2.rules * pr + so2.rules * pr * sr;
        }
        (work, probes(&p.add, &s.add, &so.add, &self.conversions))
    }
}

/// A maior cadeia de `add` de uma tabela: `add`s em que cada um é começo (PFX) ou fim (SFX) do
/// seguinte, contando uma a uma as regras de mesmo `add`. Uma palavra que começa (ou termina) pelo
/// último visita todas elas.
struct Chain {
    rules: u64,
    /// O `add` mais longo da cadeia.
    add: String,
}

/// A maior cadeia dos `adds`, sem os caracteres do `IGNORE` (que o parse tira deles,
/// parser.rs:216-225). O sufixo vira prefixo do texto ao contrário; em ordem, um prefixo vem antes
/// de quem o estende, e a pilha guarda a cadeia aberta.
fn chain<'a>(adds: impl Iterator<Item = &'a str>, suffix: bool, ignore: &[char]) -> Chain {
    let mut keys: Vec<String> = adds
        .map(|add| {
            let kept = add.chars().filter(|c| !ignore.contains(c));
            if suffix {
                kept.rev().collect()
            } else {
                kept.collect()
            }
        })
        .collect();
    keys.sort_unstable();
    let mut open: Vec<(usize, u64)> = Vec::new();
    let mut best = (0, 0);
    for (at, key) in keys.iter().enumerate() {
        while open
            .last()
            .is_some_and(|&(top, _)| !key.starts_with(keys[top].as_str()))
        {
            open.pop();
        }
        let rules = open.last().map_or(0, |&(_, rules)| rules) + 1;
        if rules > best.0 {
            best = (rules, at);
        }
        open.push((at, rules));
    }
    let add = keys.get(best.1).map_or_else(String::new, |key| {
        if suffix {
            key.chars().rev().collect()
        } else {
            key.clone()
        }
    });
    Chain { rules: best.0, add }
}

/// As palavras de prova do teste de velocidade de um par (AppSec r34 B1/B1'), sem repetidas e até
/// 64 caracteres (o maior termo que chega ao motor):
/// - um radical (`x` e, para condição de várias letras, `xxxxxxxx`) com os `add` das maiores
///   cadeias — PFX `p`, SFX `s` e SFX de continuação `c` —: `x`, `x+s`, `x+s+s`, `x+s+c`, `p+x`,
///   `p+x+s`, `p+x+s+s` e `p+x+s+c`;
/// - cada padrão `t` do `ICONV`, que o spellbook converte depois de medir a palavra (até 8
///   caracteres por caractere): `t` repetido até 64 caracteres, `t` repetido antes de `s` e, com o
///   padrão que mais expande (`e`), `t` repetido até a troca dele cobrir 64 caracteres (um `add`
///   inteiro) depois e antes de `e` repetido — a palavra convertida mais longa, com o fim (ou o
///   começo) que uma cadeia de `add` pede.
fn probes(
    prefix: &str,
    suffix: &str,
    continuation: &str,
    conversions: &[(String, usize)],
) -> Vec<String> {
    let mut probes = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |word: String| {
        if word.chars().count() <= TERM_MAX_CHARS && seen.insert(word.clone()) {
            probes.push(word);
        }
    };
    let tails = [
        String::new(),
        suffix.to_owned(),
        format!("{suffix}{suffix}"),
        format!("{suffix}{continuation}"),
    ];
    for stem in ["x", "xxxxxxxx"] {
        for head in ["", prefix] {
            for tail in &tails {
                push(format!("{head}{stem}{tail}"));
            }
        }
    }
    let chars = |text: &str| text.chars().count();
    // O que mais expande: a maior troca por caractere do padrão.
    let filler = conversions
        .iter()
        .max_by(|(a, a_to), (b, b_to)| (a_to * chars(b)).cmp(&(b_to * chars(a))))
        .map(|(fill, _)| fill);
    let room = TERM_MAX_CHARS.saturating_sub(chars(suffix));
    for (pattern, to) in conversions {
        let n = chars(pattern);
        push(pattern.repeat(TERM_MAX_CHARS / n));
        if room >= n {
            push(pattern.repeat(room / n) + suffix);
        }
        if let Some(fill) = filler {
            let times = TERM_MAX_CHARS
                .div_ceil((*to).max(1))
                .min(TERM_MAX_CHARS / n);
            let tail = pattern.repeat(times);
            let fill = fill.repeat((TERM_MAX_CHARS - times * n) / chars(fill));
            push(format!("{fill}{tail}"));
            push(format!("{tail}{fill}"));
        }
    }
    probes
}

/// O que o `vet_aff` tira de um `.aff` aceito para o resto da carga do par.
struct Vetted {
    /// Os caracteres do `IGNORE` (de todas as linhas): o spellbook os tira das palavras do `.dic`.
    ignore: Vec<char>,
    /// As palavras de prova do teste de velocidade.
    probes: Vec<String>,
}

/// Confere o `.aff` de um par antes do parse (D-R34-4; `read_aff`) e o trabalho por palavra dele:
/// mais de 100.000 regras de afixo visitadas no pior caso → `Rules` (AppSec r34 B1).
fn vet_aff(aff: &str) -> Result<Vetted, Refusal> {
    let (shape, ignore) = read_aff(aff)?;
    let (work, probes) = shape.work(&ignore);
    if work > AFFIX_WORK_MAX {
        return Err(Refusal::Rules);
    }
    Ok(Vetted { ignore, probes })
}

/// Lê o `.aff` de um par como o parser do spellbook: o BOM inicial sai, linha começada por `#` é
/// comentário, a 1ª palavra é a diretiva e uma tabela é o cabeçalho com a contagem seguido dessas
/// linhas. Linha acima de 4 KiB → `Lines`; diretiva recusada → `Directive`; regras demais, condição
/// longa ou troca longa (`tira`/`põe`, `ICONV`/`OCONV`, `REP`, `TRY`/`KEY`) → `Rules`; tabela
/// interrompida ou contagem malformada → `Parse` (o parse também recusaria). Devolve as regras de
/// afixo, os padrões do `ICONV` e os caracteres do `IGNORE`.
fn read_aff(aff: &str) -> Result<(Shape, Vec<char>), Refusal> {
    let body = aff.strip_prefix('\u{FEFF}').unwrap_or(aff);
    let mut counts = AffCounts::default();
    let mut shape = Shape::default();
    let mut flags = Flags::Short;
    let mut ignore = Vec::new();
    // A tabela aberta: a diretiva, as linhas que faltam e, num PFX/SFX, a flag do cabeçalho.
    let mut table: Option<(&str, usize, Option<u16>)> = None;
    for line in body.lines() {
        if line.len() > LINE_MAX_BYTES {
            return Err(Refusal::Lines);
        }
        if line.trim_start().starts_with('#') {
            continue;
        }
        let mut words = line.split_whitespace();
        let key = words.next();
        if let Some((name, left, flag)) = table.as_mut() {
            if key != Some(*name) {
                return Err(Refusal::Parse);
            }
            counts.row(name, words.clone())?;
            match (*name, *flag) {
                ("PFX" | "SFX", Some(flag)) => {
                    if let Some(add) = words.nth(2) {
                        shape.push(name, flag, add, flags);
                    }
                }
                ("ICONV", _) => {
                    if let (Some(from), Some(to)) = (words.next(), words.next()) {
                        shape.convert(from, to);
                    }
                }
                _ => {}
            }
            *left -= 1;
            if *left == 0 {
                table = None;
            }
            continue;
        }
        let Some(key) = key else {
            continue;
        };
        if refused_directive(key) {
            return Err(Refusal::Directive);
        }
        let (rows, flag) = match key {
            "PFX" | "SFX" => {
                let flag = words.next().and_then(|token| flags.one(token));
                (words.nth(1), flag)
            }
            "REP" | "ICONV" | "OCONV" | "MAP" | "BREAK" => (words.next(), None),
            "FLAG" => {
                flags = Flags::named(words.next());
                continue;
            }
            "IGNORE" => {
                ignore.extend(words.next().unwrap_or_default().chars());
                continue;
            }
            // As letras das sugestões por edição e o teclado (AppSec r34 B1', a5).
            "TRY" | "KEY" => {
                if words
                    .next()
                    .is_some_and(|letters| letters.chars().count() > TRY_MAX_CHARS)
                {
                    return Err(Refusal::Rules);
                }
                continue;
            }
            _ => continue,
        };
        let rows: usize = rows
            .and_then(|rows| rows.parse().ok())
            .ok_or(Refusal::Parse)?;
        if rows > 0 {
            table = Some((key, rows, flag));
        }
    }
    match table {
        Some(_) => Err(Refusal::Parse),
        None => Ok((shape, ignore)),
    }
}

/// As 128 palavras do teste de velocidade.
static CALIBRATION_WORDS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut words = Vec::with_capacity(CALIBRATION.len() * 4);
    for word in CALIBRATION {
        let mut chars = word.chars();
        let title = chars
            .next()
            .map(|first| first.to_uppercase().chain(chars).collect())
            .unwrap_or_default();
        words.extend([
            word.to_owned(),
            title,
            word.to_uppercase(),
            format!("{word}x"),
        ]);
    }
    words
});

/// O tempo do dicionário em `words`; passou de `limit` → `None`, na hora (entre palavras).
fn timed(dictionary: &Dictionary, words: &[String], limit: Duration) -> Option<Duration> {
    let started = Instant::now();
    for word in words {
        black_box(dictionary.check(word));
        if started.elapsed() > limit {
            return None;
        }
    }
    Some(started.elapsed())
}

/// A palavra de prova mais lenta do dicionário (o índice), cada uma até `limit` (AppSec r34 c1
/// B1'): uma acima é medida de novo, até 3 vezes, e vale a menor (uma pausa do sistema não reprova
/// o par). Passou → `None`.
fn slowest_probe(dictionary: &Dictionary, probes: &[String], limit: Duration) -> Option<usize> {
    let (mut slowest, mut worst) = (0, Duration::ZERO);
    for (at, word) in probes.iter().enumerate() {
        let mut took = Duration::MAX;
        for _ in 0..3 {
            let started = Instant::now();
            black_box(dictionary.check(word));
            took = took.min(started.elapsed());
            if took <= limit {
                break;
            }
        }
        if took > limit {
            return None;
        }
        if took > worst {
            (slowest, worst) = (at, took);
        }
    }
    Some(slowest)
}

/// Verifica a ortografia de `words` (até 20.000) em `lang` (só `pt-BR`). Devolve os índices das
/// palavras desconhecidas. O pedido mais novo vence (`CANCELLED`); `words: []` só cancela.
#[tauri::command]
pub async fn spell_check(
    spell: State<'_, Arc<SpellState>>,
    lang: String,
    words: Vec<String>,
) -> Result<Vec<u32>, AppError> {
    let started = Instant::now();
    let count = words.len();
    let result = match admit(&lang, count) {
        Ok(()) => {
            let spell = spell.inner().clone();
            let generation = spell.next_check();
            blocking(move || spell.check(generation, &words, LIMITS.check)).await
        }
        Err(error) => Err(error),
    };
    // Só contagens, o código e o tempo: nunca as palavras.
    println!(
        "spell: check ({count} palavra(s)) -> {} em {} ms",
        result.as_ref().map_or_else(
            |error| error.code.to_owned(),
            |unknown| format!("{} desconhecida(s)", unknown.len())
        ),
        started.elapsed().as_millis()
    );
    result
}

/// Até 5 sugestões para `word` em `lang` (só `pt-BR`). Uma por vez; o pedido mais novo vence; a
/// parte dos pares passou de 3 s → `TIMEOUT`.
#[tauri::command]
pub async fn spell_suggest(
    spell: State<'_, Arc<SpellState>>,
    lang: String,
    word: String,
) -> Result<Vec<String>, AppError> {
    let started = Instant::now();
    let result = match lang_ok(&lang) {
        Ok(()) => {
            let spell = spell.inner().clone();
            let generation = spell.next_suggestion();
            blocking(move || spell.suggest(generation, &word, LIMITS.check)).await
        }
        Err(error) => Err(error),
    };
    println!(
        "spell: suggest -> {} em {} ms",
        result.as_ref().map_or_else(
            |error| error.code.to_owned(),
            |found| format!("{} sugestão(ões)", found.len())
        ),
        started.elapsed().as_millis()
    );
    result
}

/// Relê as camadas do usuário: a global e, com `token`, a da pasta aberta. Do webview vem só o
/// token; nenhum caminho entra ou sai.
#[tauri::command]
pub async fn spell_reload(
    spell: State<'_, Arc<SpellState>>,
    global: State<'_, Arc<GlobalDictionaries>>,
    vault: State<'_, VaultState>,
    token: Option<u32>,
) -> Result<Reloaded, AppError> {
    let started = Instant::now();
    let spell = spell.inner().clone();
    let global = global.inner().clone();
    let vault = vault.inner().clone();
    let ticket = spell.next_reload();
    let result = blocking(move || spell.reload_for(ticket, &global, &vault, token, LIMITS)).await;
    match &result {
        Ok(done) => {
            let Refused {
                lines,
                directive,
                rules,
                parse,
                timeout,
                slow,
            } = done.refused;
            println!(
                "spell: reload ({}) -> {} termo(s), {} par(es), {} fora (no motor: linhas {lines}, \
                 diretiva {directive}, regras {rules}, parse {parse}, prazo {timeout}, lento {slow}) \
                 em {} ms",
                if token.is_some() { "global + pasta" } else { "global" },
                done.words,
                done.pairs,
                done.skipped,
                started.elapsed().as_millis()
            );
        }
        Err(error) => println!("spell: reload -> {}", error.code),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;
    use std::fmt::Write as _;
    use std::fs;
    use std::sync::mpsc;

    /// Termo que o pt_BR do VERO não tem (o "colecistectomia" do desenho ele já tem).
    const TERM: &str = "colangiopancreatografia";
    /// Termo inventado das listas e dos pares de prova.
    const PAIR_TERM: &str = "zubênico";
    /// Par mínimo com o plural por `SFX` (UTF-8).
    const PLURAL_AFF: &[u8] = b"SET UTF-8\nSFX S Y 1\nSFX S 0 s .\n";
    const PLURAL_DIC: &str = "1\nzubênico/S\n";
    /// A palavra-gatilho do par da AppSec r34 (B1) e o `.dic` dele.
    const TRIGGER: &str = "zqxqqqq";
    const BOMB_DIC: &str = "1\nabc/AB\n";

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(value) => panic!("esperava erro, veio {value:?}"),
            Err(error) => error.code,
        }
    }

    fn owned(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    /// `spell_check` com uma geração nova e o prazo de produção.
    fn unknown(spell: &SpellState, list: &[&str]) -> Vec<u32> {
        let generation = spell.next_check();
        spell.check(generation, &owned(list), LIMITS.check).unwrap()
    }

    fn suggestions(spell: &SpellState, word: &str) -> Vec<String> {
        let generation = spell.next_suggestion();
        spell.suggest(generation, word, LIMITS.check).unwrap()
    }

    /// Só o veredito do `vet_aff`.
    fn vetted(aff: &str) -> Result<(), Refusal> {
        vet_aff(aff).map(|_| ())
    }

    /// Os pares `(aff, dic)` no motor sem passar pelas conferências da recarga (o que um par lento
    /// que escapasse delas faria), ligados e na ordem dada (a da camada global antes da da pasta).
    fn install_unvetted(spell: &SpellState, pairs: &[(&str, &str)]) {
        let pairs = pairs
            .iter()
            .map(|(aff, dic)| Pair::new(Dictionary::new(aff, dic).unwrap()))
            .collect();
        *spell.engine.lock() = Arc::new(Engine {
            pairs,
            ..Engine::default()
        });
    }

    /// Quais pares do motor estão ligados, na ordem.
    fn on(spell: &SpellState) -> Vec<bool> {
        spell.engine().pairs.iter().map(|pair| pair.on()).collect()
    }

    /// Espera a thread das consultas terminar o que está fazendo (até 60 s): um trabalho vazio na
    /// fila, de novo enquanto ela estiver ocupada.
    fn drain(spell: &SpellState) {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            match spell.lookups.call(until, || false, |_: &AtomicBool| ()) {
                Ok(()) => return,
                Err(Stop::Busy) => thread::sleep(POLL),
                Err(stop) => panic!("thread das consultas: {stop:?}"),
            }
        }
    }

    /// Uma condição `[^…]` diferente para cada `i` (nenhuma linha de afixo igual a outra).
    fn condition(mut i: usize) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789";
        let mut class = String::from("[^");
        loop {
            class.push(char::from(ALPHABET[i % ALPHABET.len()]));
            i /= ALPHABET.len();
            if i == 0 {
                break;
            }
        }
        class.push(']');
        class
    }

    /// O `.aff` do par da AppSec r34 (B1, a0-a2): `p` PFX `zq`, `n` SFX `qq` (condições distintas,
    /// nenhuma linha igual) e um SFX `qq/A` que faz dos `n` alvos de continuação. Conferir
    /// `zqxqqqq` custa p × n² iterações no spellbook (checker.rs:878-982); nenhuma das 128 palavras
    /// fixas do teste de velocidade começa com `zq` nem termina em `qq`.
    fn bomb(p: usize, n: usize) -> String {
        let mut aff = String::from("SET UTF-8\n");
        if p > 0 {
            let _ = writeln!(aff, "PFX P Y {p}");
            for i in 0..p {
                let _ = writeln!(aff, "PFX P 0 zq {}", condition(i));
            }
        }
        let _ = writeln!(aff, "SFX A Y {n}");
        for i in 0..n {
            let _ = writeln!(aff, "SFX A 0 qq {}", condition(i));
        }
        aff.push_str("SFX B Y 1\nSFX B 0 qq/A .\n");
        aff
    }

    /// O `.aff` do par a4 da AppSec r34 c1 (B1'): `ICONV ж <to>` e 25.000 SFX `q×64` com condições
    /// distintas (2,0 MB). O spellbook mede a palavra antes do `ICONV`: cada `ж` chega ao motor como
    /// `to`, e uma palavra que termina em 64 `q` visita as 25.000 regras com o radical inteiro.
    fn a4(to: &str) -> String {
        let q64 = "q".repeat(64);
        let mut aff = format!("SET UTF-8\nICONV 1\nICONV ж {to}\nSFX A Y 25000\n");
        for i in 0..25_000 {
            let _ = writeln!(aff, "SFX A 0 {q64} {}", condition(i));
        }
        aff
    }

    /// Os dados do app (camada global em `dictionaries/`) e uma pasta aberta (camada em
    /// `.simplemd/dictionaries/`), com o corretor.
    struct World {
        data: TempDir,
        vault: TempDir,
        global: GlobalDictionaries,
        spell: SpellState,
    }

    impl World {
        fn new() -> Self {
            let data = TempDir::new();
            let global = GlobalDictionaries::new(data.0.clone());
            Self {
                data,
                vault: TempDir::new(),
                global,
                spell: SpellState::default(),
            }
        }

        fn global_file(&self, rel: &str, bytes: &[u8]) {
            self.data.put(&format!("dictionaries/{rel}"), bytes);
        }

        fn folder_file(&self, rel: &str, bytes: &[u8]) {
            self.vault
                .put(&format!(".simplemd/dictionaries/{rel}"), bytes);
        }

        fn reload(&self, folder: bool) -> Reloaded {
            self.reload_with(folder, LIMITS)
        }

        fn reload_with(&self, folder: bool, limits: Limits) -> Reloaded {
            let ticket = self.spell.next_reload();
            let folder = folder.then_some(self.vault.0.as_path());
            self.spell
                .reload(ticket, &self.global, folder, limits)
                .unwrap()
        }
    }

    /// AC-R34-1: "excessão" é erro; "exceção" não, em minúsculas, Título, MAIÚSCULAS e NFD. Só o
    /// dicionário embutido: nenhuma camada, nenhuma rede.
    #[test]
    fn spell_ac1_excessao_is_an_error_and_excecao_is_not() {
        let spell = SpellState::default();
        let nfd = "excec\u{0327}a\u{0303}o";
        assert_ne!(nfd, "exceção");
        assert_eq!(
            unknown(&spell, &["excessão", "exceção", "Exceção", "EXCEÇÃO", nfd]),
            [0]
        );
    }

    /// AC-R34-1: as sugestões de "excessão" (até 5) trazem "exceção" primeiro; palavra única antes
    /// de forma com espaço; o mesmo em Título.
    #[test]
    fn spell_ac1_suggestions_for_excessao_bring_excecao() {
        let spell = SpellState::default();
        for (word, expected) in [("excessão", "exceção"), ("Excessão", "Exceção")] {
            let found = suggestions(&spell, word);
            assert!(found.len() <= MAX_SUGGESTIONS, "{found:?}");
            assert_eq!(
                found.first().map(String::as_str),
                Some(expected),
                "{found:?}"
            );
            let spaced = found
                .iter()
                .position(|s| s.contains(' '))
                .unwrap_or(found.len());
            assert!(found[spaced..].iter().all(|s| s.contains(' ')), "{found:?}");
        }
    }

    /// Só `pt-BR`, exato; até 20.000 palavras (`TOO_MANY_WORDS { max }` acima) — e as 20.000 são
    /// conferidas.
    #[test]
    fn spell_only_pt_br_and_at_most_20000_words() {
        assert_eq!(code(admit("en-US", 1)), "UNSUPPORTED_LANG");
        assert_eq!(code(admit("pt-br", 1)), "UNSUPPORTED_LANG");
        assert_eq!(code(lang_ok("pt")), "UNSUPPORTED_LANG");
        let error = admit("pt-BR", 20_001).unwrap_err();
        assert_eq!(error.code, "TOO_MANY_WORDS");
        assert_eq!(error.detail, Some(serde_json::json!({ "max": 20_000 })));
        assert!(admit("pt-BR", 20_000).is_ok());
        let spell = SpellState::default();
        let many: Vec<String> = ["casa", "exceção", "Exceção", "excessão"]
            .iter()
            .cycle()
            .take(20_000)
            .map(|word| (*word).to_owned())
            .collect();
        let generation = spell.next_check();
        let found = spell
            .check(generation, &many, Duration::from_secs(120))
            .unwrap();
        assert_eq!(found.len(), 5_000);
        assert!(found.iter().all(|index| index % 4 == 3));
    }

    /// O que não é termo v1 (vazio, espaço até nas pontas, Cf, Cc, `#`, mais de 64 caracteres)
    /// nunca é marcado; uma palavra desconhecida de 64 caracteres é.
    #[test]
    fn spell_words_that_are_not_terms_are_never_flagged() {
        let spell = SpellState::default();
        let long = "x".repeat(65);
        let huge = "y".repeat(10_000);
        let at_limit = "qz".repeat(32);
        let list = [
            "",
            " casa",
            "excessão ",
            "a b",
            "ex\u{200B}cessão",
            "ex\u{7}cessão",
            "#excessão",
            long.as_str(),
            huge.as_str(),
            at_limit.as_str(),
        ];
        assert_eq!(unknown(&spell, &list), [9]);
    }

    /// O pedido mais novo vence: o anterior para com `CANCELLED`; `words: []` (uma geração nova)
    /// cancela o anterior e devolve `[]`.
    #[test]
    fn spell_newer_check_cancels_the_older_and_empty_only_cancels() {
        let spell = SpellState::default();
        let older = spell.next_check();
        let newer = spell.next_check();
        let words = owned(&["excessão"]);
        assert_eq!(code(spell.check(older, &words, LIMITS.check)), "CANCELLED");
        assert_eq!(spell.check(newer, &words, LIMITS.check).unwrap(), [0]);
        let pending = spell.next_check();
        let cancel = spell.next_check();
        assert!(spell.check(cancel, &[], LIMITS.check).unwrap().is_empty());
        assert_eq!(
            code(spell.check(pending, &words, LIMITS.check)),
            "CANCELLED"
        );
    }

    /// D-R34-4, AppSec r34 c1 B1' (4): passou do prazo → `TIMEOUT { seconds }`, e desliga só o par
    /// que segurava a thread das consultas — o lento, da pasta —, não o outro, da camada global; com
    /// o prazo vencido antes dos pares, nenhum. Depois, o par global segue respondendo e o lento nem
    /// é consultado.
    #[test]
    fn spell_deadline_times_out_and_turns_off_only_the_pair_holding_the_thread() {
        let spell = SpellState::default();
        let plural = std::str::from_utf8(PLURAL_AFF).unwrap();
        install_unvetted(&spell, &[(plural, PLURAL_DIC), (&bomb(1, 2_000), BOMB_DIC)]);
        let generation = spell.next_check();
        let error = spell
            .check(generation, &owned(&["zubênicos"]), Duration::ZERO)
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert_eq!(error.detail, Some(serde_json::json!({ "seconds": 0 })));
        assert_eq!(on(&spell), [true, true], "o prazo acabou antes dos pares");
        assert!(unknown(&spell, &["zubênicos"]).is_empty());

        let started = Instant::now();
        let generation = spell.next_check();
        let words = owned(&["zubênicos", TRIGGER]);
        let error = spell
            .check(generation, &words, Duration::from_millis(20))
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(on(&spell), [true, false]);
        drain(&spell);
        let started = Instant::now();
        assert_eq!(unknown(&spell, &["zubênicos", TRIGGER]), [1]);
        let after = started.elapsed();
        assert!(
            after < Duration::from_secs(1),
            "o par lento nem é consultado: {after:?}"
        );
    }

    /// Code review r34 NB-3, AppSec r34 c1 B1' (4): a parte dos pares de uma sugestão que passa do
    /// prazo → `TIMEOUT { seconds }`, e só o par que segurava a thread desliga; o outro segue
    /// sugerindo. Com o prazo vencido antes dos pares, nenhum desliga.
    #[test]
    fn spell_the_suggest_deadline_turns_off_only_the_pair_holding_the_thread() {
        let spell = SpellState::default();
        let plural = std::str::from_utf8(PLURAL_AFF).unwrap();
        install_unvetted(&spell, &[(plural, PLURAL_DIC), (&bomb(1, 400), BOMB_DIC)]);
        let inflected = "zubênicos".to_owned();
        assert!(suggestions(&spell, "zubênicoss").contains(&inflected));
        let generation = spell.next_suggestion();
        let error = spell
            .suggest(generation, "zubênicoss", Duration::ZERO)
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert_eq!(error.detail, Some(serde_json::json!({ "seconds": 0 })));
        assert_eq!(on(&spell), [true, true]);

        let generation = spell.next_suggestion();
        let started = Instant::now();
        let error = spell
            .suggest(generation, TRIGGER, Duration::from_millis(20))
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(on(&spell), [true, false]);
        drain(&spell);
        assert!(suggestions(&spell, "zubênicoss").contains(&inflected));
    }

    /// D-R34-4: o par desligado por um estouro fica assim — a lista dele segue valendo — até a
    /// próxima recarga, que traz os pares de novo, ligados.
    #[test]
    fn spell_a_pair_turned_off_comes_back_on_the_next_reload() {
        let world = World::new();
        world.global_file("zub.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/zub.aff", PLURAL_AFF);
        world.global_file("hunspell/zub.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.words, done.pairs, done.skipped), (1, 1, 0));
        assert!(unknown(&world.spell, &["zubênicos"]).is_empty());
        // O estouro com o par em consulta, como no `overrun`.
        let holder = &world.spell.holder;
        let pair = Arc::clone(&world.spell.engine().pairs[0]);
        holder.consult(&pair, || holder.blame(true, LIMITS.check));
        drop(pair);
        assert_eq!(on(&world.spell), [false]);
        assert_eq!(unknown(&world.spell, &["zubênicos", PAIR_TERM]), [0]);
        world.reload(false);
        assert_eq!(on(&world.spell), [true]);
        assert!(unknown(&world.spell, &["zubênicos"]).is_empty());
    }

    /// AC-R34-2: um termo de `pessoal.txt` (global) e de `.simplemd/dictionaries/medicos.txt`
    /// (pasta) deixa de ser erro depois do reload — em minúsculas, Título, MAIÚSCULAS e NFD (o
    /// arquivo também pode vir em NFD) — e, tirado do arquivo, volta a ser erro no reload seguinte.
    #[test]
    fn spell_ac2_global_and_folder_terms_stop_being_errors() {
        let world = World::new();
        let upper = TERM.to_uppercase();
        let title = "Colangiopancreatografia";
        assert_eq!(unknown(&world.spell, &[TERM]), [0]);
        world.global_file("pessoal.txt", format!("# minhas\n{TERM}\n").as_bytes());
        assert_eq!(
            unknown(&world.spell, &[TERM]),
            [0],
            "só vale depois do reload"
        );
        let done = world.reload(false);
        assert_eq!(done.langs, ["pt-BR"]);
        assert_eq!((done.words, done.pairs, done.skipped), (1, 0, 0));
        assert!(unknown(&world.spell, &[TERM, title, &upper]).is_empty());
        world.global_file("pessoal.txt", b"# vazio\n");
        assert_eq!(world.reload(false).words, 0);
        assert_eq!(unknown(&world.spell, &[TERM]), [0]);

        let nfd = "zube\u{0302}nico";
        world.folder_file("medicos.txt", format!("{nfd}\n").as_bytes());
        assert_eq!(
            world.reload(false).words,
            0,
            "sem a pasta, a camada dela não entra"
        );
        assert_eq!(world.reload(true).words, 1);
        assert!(unknown(&world.spell, &[PAIR_TERM, "Zubênico", "ZUBÊNICO", nfd]).is_empty());
    }

    /// AC-R34-2: a pasta vem pelo token (`VaultState::root`): sem pasta → `NO_VAULT`; o token de
    /// uma pasta já trocada → `VAULT_CLOSED`, e as camadas carregadas ficam.
    #[test]
    fn spell_ac2_the_folder_comes_by_token_and_an_old_token_is_closed() {
        let world = World::new();
        world.folder_file("medicos.txt", format!("{PAIR_TERM}\n").as_bytes());
        let vault = VaultState::default();
        let reload = |token| {
            let ticket = world.spell.next_reload();
            world
                .spell
                .reload_for(ticket, &world.global, &vault, Some(token), LIMITS)
        };
        assert_eq!(code(reload(7)), "NO_VAULT");
        let token = vault.stage(world.vault.0.clone()).unwrap();
        assert_eq!(reload(token).unwrap().words, 1);
        assert!(unknown(&world.spell, &[PAIR_TERM]).is_empty());
        let other = TempDir::new();
        let newer = vault.stage(other.0.clone()).unwrap();
        vault.root(newer).unwrap();
        assert_eq!(code(reload(token)), "VAULT_CLOSED");
        assert!(unknown(&world.spell, &[PAIR_TERM]).is_empty());
    }

    /// AC-R34-2: o par ISO-8859-1 de uma lista importada, com o plural por `SFX`, aceita a flexão
    /// (em Título e MAIÚSCULAS também); a lista sozinha, só a palavra.
    #[test]
    fn spell_ac2_latin1_pair_with_a_plural_suffix_accepts_the_inflection() {
        let world = World::new();
        world.folder_file(
            "termos.txt",
            format!("# Importado de termos.dic em 2026-11-09\n{PAIR_TERM}\n").as_bytes(),
        );
        assert_eq!(world.reload(true).words, 1);
        assert_eq!(unknown(&world.spell, &[PAIR_TERM, "zubênicos"]), [1]);
        world.folder_file(
            "hunspell/termos.aff",
            b"SET ISO8859-1\nTRY \xe1\xea\nSFX S Y 1\nSFX S 0 s .\n",
        );
        world.folder_file("hunspell/termos.dic", b"1\nzub\xeanico/S\n");
        let done = world.reload(true);
        assert_eq!((done.words, done.pairs, done.skipped), (1, 1, 0));
        assert_eq!(
            unknown(
                &world.spell,
                &[
                    PAIR_TERM,
                    "zubênicos",
                    "Zubênicos",
                    "ZUBÊNICOS",
                    "zubênicoss"
                ]
            ),
            [4]
        );
    }

    /// AC-R34-2: um par sem o `<nome>.txt` não carrega (nem conta); com a lista e só metade do
    /// par, fica de fora.
    #[test]
    fn spell_ac2_a_pair_without_its_list_is_not_loaded() {
        let world = World::new();
        world.folder_file("hunspell/orfao.aff", PLURAL_AFF);
        world.folder_file("hunspell/orfao.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(true);
        assert_eq!((done.words, done.pairs, done.skipped), (0, 0, 0));
        assert_eq!(unknown(&world.spell, &[PAIR_TERM, "zubênicos"]), [0, 1]);
        world.folder_file("meio.txt", PAIR_TERM.as_bytes());
        world.folder_file("hunspell/meio.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(true);
        assert_eq!((done.words, done.pairs, done.skipped), (1, 0, 1));
    }

    /// AC-R34-2: link (a lista, o par ou a pasta `hunspell/`) fica de fora e é contado.
    #[cfg(unix)]
    #[test]
    fn spell_ac2_links_are_skipped() {
        use std::os::unix::fs::symlink;
        let world = World::new();
        let outside = TempDir::new();
        outside.put("fora.txt", format!("{PAIR_TERM}\n").as_bytes());
        outside.put("hunspell/lista.aff", PLURAL_AFF);
        outside.put("hunspell/lista.dic", PLURAL_DIC.as_bytes());
        world.folder_file("pessoal.txt", b"casa\n");
        world.folder_file("lista.txt", format!("{PAIR_TERM}\n").as_bytes());
        let layer = world.vault.0.join(".simplemd/dictionaries");
        symlink(outside.0.join("fora.txt"), layer.join("link.txt")).unwrap();
        fs::create_dir_all(layer.join("hunspell")).unwrap();
        for ext in ["aff", "dic"] {
            let name = format!("lista.{ext}");
            symlink(
                outside.0.join("hunspell").join(&name),
                layer.join("hunspell").join(&name),
            )
            .unwrap();
        }
        let done = world.reload(true);
        assert_eq!((done.words, done.pairs, done.skipped), (2, 0, 2));
        assert_eq!(unknown(&world.spell, &["zubênicos"]), [0]);
        fs::remove_dir_all(layer.join("hunspell")).unwrap();
        symlink(outside.0.join("hunspell"), layer.join("hunspell")).unwrap();
        let done = world.reload(true);
        assert_eq!((done.words, done.pairs, done.skipped), (2, 0, 2));
    }

    /// AC-R34-2: uma camada guarda os primeiros 200.000 termos (como o leitor do app); o 200.001º
    /// fica de fora e a camada conta em `skipped`.
    #[test]
    fn spell_ac2_a_layer_keeps_200000_terms_and_skips_the_rest() {
        let world = World::new();
        let mut text = String::new();
        for n in 0..200_001u32 {
            let _ = writeln!(text, "t{n:06}x");
        }
        world.global_file("pessoal.txt", text.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.words, done.skipped), (200_000, 1));
        assert_eq!(
            unknown(&world.spell, &["t000000x", "t199999x", "t200000x"]),
            [2]
        );
    }

    /// Um termo do usuário vence o `FORBIDDENWORD` da base ("Kg" é proibido no VERO) e guarda a
    /// `/` (o separador das flags no `.dic`).
    #[test]
    fn spell_user_terms_win_over_forbidden_words_and_keep_slashes() {
        let world = World::new();
        assert_eq!(unknown(&world.spell, &["Kg", "km/h", "km"]), [0, 1]);
        world.global_file("pessoal.txt", b"Kg\nkm/h\n");
        world.reload(false);
        assert!(unknown(&world.spell, &["Kg", "km/h", "km"]).is_empty());
    }

    /// D-R34-6: um termo do usuário entra nas sugestões antes do n-grama da base; os pares
    /// também sugerem (sem n-grama).
    #[test]
    fn spell_suggestions_bring_user_terms_and_pairs() {
        let world = World::new();
        world.global_file("pessoal.txt", format!("{TERM}\n").as_bytes());
        world.global_file("zub.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/zub.aff", PLURAL_AFF);
        world.global_file("hunspell/zub.dic", PLURAL_DIC.as_bytes());
        world.reload(false);
        let found = suggestions(&world.spell, "colangiopancreatografai");
        assert_eq!(found.first().map(String::as_str), Some(TERM), "{found:?}");
        // O `.aff` do par não tem `TRY`: a edição que serve é a da letra a mais.
        let found = suggestions(&world.spell, "zubênicoss");
        assert!(found.contains(&"zubênicos".to_owned()), "{found:?}");
    }

    /// AppSec r34 N1 (a4): o `OCONV` de um par escreve o que quiser na saída — o par sozinho sugere
    /// marcação (`casa` → `c<img…>s<img…>`; `zubqx` → `<img…>ubqx`, `<b>ubqx`) —, mas só sai
    /// sugestão que vale como texto: em NFC, até 64 caracteres, sem `<` nem `>` e cada parte entre
    /// espaços simples um termo (sem Cc, Cf nem outro espaço). Pelo motor, a palavra que só a lista
    /// e o par conhecem volta limpa, pela lista; a troca de 28 caracteres nem carrega (AppSec r34 c1
    /// B1': até 8).
    #[test]
    fn spell_suggestions_carry_no_markup_nor_controls() {
        let payload = "<img/src=x/onerror=alert(1)>";
        let appsec = format!("SET UTF-8\nTRY asc\nOCONV 1\nOCONV a {payload}\n");
        let aff = |to: &str| format!("SET UTF-8\nTRY z\nOCONV 1\nOCONV z {to}\n");
        for (aff, dic, word, shown) in [
            (appsec, "1\ncasa\n", "caas", payload),
            (aff(payload), "1\nzubqx\n", "zubqxx", payload),
            (aff("<b>"), "1\nzubqx\n", "zubqxx", "<b>ubqx"),
        ] {
            let mut raw = Vec::new();
            edits(&Dictionary::new(&aff, dic).unwrap(), word, &mut raw);
            assert!(raw.iter().any(|s| s.contains(shown)), "{raw:?}");
        }
        assert_eq!(vetted(&aff(payload)), Err(Refusal::Rules));
        let world = World::new();
        world.global_file("oconv.txt", b"zubqx\n");
        world.global_file("hunspell/oconv.aff", aff("<b>").as_bytes());
        world.global_file("hunspell/oconv.dic", b"1\nzubqx\n");
        assert_eq!(world.reload(false).pairs, 1);
        let found = suggestions(&world.spell, "zubqxx");
        assert!(found.contains(&"zubqx".to_owned()), "{found:?}");
        assert!(found.iter().all(|s| !s.contains(['<', '>'])), "{found:?}");
        for (suggestion, shown) in [
            ("bem vindo", Some("bem vindo")),
            ("excec\u{0327}a\u{0303}o", Some("exceção")),
            ("c<img/src=x>s", None),
            ("a>b", None),
            ("ca\u{7}sa", None),
            ("ca\u{200B}sa", None),
            ("ca\u{A0}sa", None),
            ("a  b", None),
            (" casa", None),
            ("#casa", None),
            ("", None),
        ] {
            assert_eq!(
                presentable(suggestion.to_owned(), "casa").as_deref(),
                shown,
                "{suggestion:?}"
            );
        }
        assert!(presentable("x".repeat(TERM_MAX_CHARS), "x").is_some());
        assert!(presentable("x".repeat(TERM_MAX_CHARS + 1), "x").is_none());
    }

    /// AppSec r34 c1 N1': também não sai sugestão com sintaxe que a palavra pedida não tem —
    /// entidade (`&lt;img…&gt;`), atributo (`a"onmouseover=…`), link do Markdown
    /// (`[x](javascript:…)`), crase, `${}` —, com uso privado ou invisível (os preenchedores Hangul
    /// U+115F, U+1160, U+3164 e U+FFA0, o CGJ, seletor de variação), com mais de 2 marcas
    /// combinantes empilhadas ou com letra latina e cirílica/grega na mesma palavra (`p\u{430}ypal`,
    /// `\u{3B1}lfa`). Passam a sintaxe que a palavra tem (`AT&T`, `(sic)`), o grego só, o vietnamita
    /// (2 marcas) e cada palavra num alfabeto. Pelo motor, o `&lt;` que o `OCONV` de um par escreve
    /// não sai.
    #[test]
    fn spell_n1c1_suggestions_carry_no_syntax_invisibles_nor_homoglyphs() {
        for (suggestion, word, shown) in [
            ("&lt;img", "casa", None),
            ("a\"onmouseover=alert(1)", "casa", None),
            ("[x](javascript:alert(1))", "casa", None),
            ("`rm`", "casa", None),
            ("${HOME}", "casa", None),
            ("ca\u{115F}sa", "casa", None),
            ("ca\u{1160}sa", "casa", None),
            ("ca\u{3164}sa", "casa", None),
            ("ca\u{FFA0}sa", "casa", None),
            ("ca\u{034F}sa", "casa", None),
            ("ca\u{FE0F}sa", "casa", None),
            ("ca\u{E000}sa", "casa", None),
            ("ca\u{F0000}sa", "casa", None),
            ("a\u{0301}\u{0302}\u{0303}", "a", None),
            ("p\u{430}ypal", "paypall", None),
            ("\u{3B1}lfa", "alfaa", None),
            ("AT&T", "AT&TT", Some("AT&T")),
            ("(sic)", "(sicc)", Some("(sic)")),
            (
                "\u{3B1}\u{3B2}\u{3B3}",
                "\u{3B1}\u{3B2}",
                Some("\u{3B1}\u{3B2}\u{3B3}"),
            ),
            ("e\u{0323}\u{0302}", "e", Some("\u{1EC7}")),
            ("\u{3B1} hélice", "\u{3B1}hélice", Some("\u{3B1} hélice")),
            ("paypal", "p\u{430}ypal", Some("paypal")),
        ] {
            assert_eq!(
                presentable(suggestion.to_owned(), word).as_deref(),
                shown,
                "{suggestion:?} para {word:?}"
            );
        }
        let aff = "SET UTF-8\nTRY z\nOCONV 1\nOCONV z &lt;b\n";
        let mut raw = Vec::new();
        edits(
            &Dictionary::new(aff, "1\nzubqx\n").unwrap(),
            "zubqxx",
            &mut raw,
        );
        assert!(raw.iter().any(|s| s.starts_with("&lt;b")), "{raw:?}");
        let world = World::new();
        world.global_file("oconv.txt", b"zubqx\n");
        world.global_file("hunspell/oconv.aff", aff.as_bytes());
        world.global_file("hunspell/oconv.dic", b"1\nzubqx\n");
        assert_eq!(world.reload(false).pairs, 1);
        let found = suggestions(&world.spell, "zubqxx");
        assert!(found.contains(&"zubqx".to_owned()), "{found:?}");
        assert!(found.iter().all(|s| !s.contains('&')), "{found:?}");
    }

    /// Sugestão: o pedido mais novo vence; o que não é termo não tem sugestão.
    #[test]
    fn spell_newer_suggestion_cancels_the_older() {
        let spell = SpellState::default();
        let older = spell.next_suggestion();
        let newer = spell.next_suggestion();
        assert_eq!(
            code(spell.suggest(older, "excessão", LIMITS.check)),
            "CANCELLED"
        );
        assert!(spell
            .suggest(newer, "excessão", LIMITS.check)
            .unwrap()
            .contains(&"exceção".to_owned()));
        assert!(suggestions(&spell, "a b").is_empty());
        assert!(suggestions(&spell, "").is_empty());
    }

    /// A recarga mais nova vence: a anterior não troca nada (`CANCELLED`).
    #[test]
    fn spell_newer_reload_wins() {
        let world = World::new();
        world.global_file("pessoal.txt", PAIR_TERM.as_bytes());
        let older = world.spell.next_reload();
        let newer = world.spell.next_reload();
        assert_eq!(
            code(world.spell.reload(older, &world.global, None, LIMITS)),
            "CANCELLED"
        );
        assert_eq!(unknown(&world.spell, &[PAIR_TERM]), [0]);
        world
            .spell
            .reload(newer, &world.global, None, LIMITS)
            .unwrap();
        assert!(unknown(&world.spell, &[PAIR_TERM]).is_empty());
    }

    /// Code review r34 NB-3: a troca das camadas confere a recarga sob a trava — a que foi passada
    /// para trás depois da última conferência (durante o parse) não instala nada (`CANCELLED`); a
    /// mais nova instala.
    #[test]
    fn spell_an_overtaken_reload_installs_nothing() {
        let spell = SpellState::default();
        let base = base().unwrap();
        let layers = || Engine {
            terms: terms_dictionary(base, &owned(&[PAIR_TERM])).unwrap(),
            ..Engine::default()
        };
        let overtaken = spell.next_reload();
        let newest = spell.next_reload();
        assert_eq!(code(spell.install(overtaken, layers())), "CANCELLED");
        assert_eq!(unknown(&spell, &[PAIR_TERM]), [0]);
        spell.install(newest, layers()).unwrap();
        assert!(unknown(&spell, &[PAIR_TERM]).is_empty());
    }

    /// AC-R34-3: `.aff` acima de 2 MiB e `.dic` acima de 10 MiB ficam de fora na leitura (o motor
    /// nem os vê); até 8 pares e 24 MiB por recarga.
    #[test]
    fn spell_ac3_pair_size_caps_are_checked_before_reading() {
        use crate::vault::dictionaries::{
            ENGINE_MAX_PAIRS, PAIR_AFF_MAX_BYTES, PAIR_DIC_MAX_BYTES,
        };
        let world = World::new();
        world.global_file("grande.txt", PAIR_TERM.as_bytes());
        let mut aff = PLURAL_AFF.to_vec();
        aff.resize(PAIR_AFF_MAX_BYTES as usize + 1, b'\n');
        world.global_file("hunspell/grande.aff", &aff);
        world.global_file("hunspell/grande.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped), (0, 1));
        assert_eq!(
            done.refused,
            Refused::default(),
            "recusado na leitura, não no motor"
        );
        world.global_file("hunspell/grande.aff", PLURAL_AFF);
        let mut dic = PLURAL_DIC.as_bytes().to_vec();
        dic.resize(PAIR_DIC_MAX_BYTES as usize + 1, b'\n');
        world.global_file("hunspell/grande.dic", &dic);
        assert_eq!(world.reload(false).skipped, 1);
        fs::remove_file(world.data.0.join("dictionaries/grande.txt")).unwrap();

        // 24 MiB: dois pares de 10 MiB cabem, o terceiro não (contado na leitura).
        let mut big = PLURAL_DIC.as_bytes().to_vec();
        big.resize(PAIR_DIC_MAX_BYTES as usize, b'\n');
        for name in ["a", "b", "c"] {
            world.global_file(&format!("{name}.txt"), PAIR_TERM.as_bytes());
            world.global_file(&format!("hunspell/{name}.aff"), PLURAL_AFF);
            world.global_file(&format!("hunspell/{name}.dic"), &big);
        }
        let sources = world.global.engine_sources(None);
        assert_eq!((sources.pairs.len(), sources.skipped), (2, 1));
        for name in ["a", "b", "c"] {
            fs::remove_file(world.data.0.join(format!("dictionaries/{name}.txt"))).unwrap();
        }

        // 8 pares: 5 na camada global e 4 na da pasta → o 9º fica de fora.
        for n in 0..9 {
            let (file, dir): (fn(&World, &str, &[u8]), _) = if n < 5 {
                (World::global_file, "global")
            } else {
                (World::folder_file, "pasta")
            };
            file(&world, &format!("{dir}{n}.txt"), PAIR_TERM.as_bytes());
            file(&world, &format!("hunspell/{dir}{n}.aff"), PLURAL_AFF);
            file(
                &world,
                &format!("hunspell/{dir}{n}.dic"),
                PLURAL_DIC.as_bytes(),
            );
        }
        let done = world.reload(true);
        assert_eq!((done.pairs, done.skipped), (ENGINE_MAX_PAIRS as u32, 1));
    }

    /// Code review r34 NB-5: os 24 MiB dos pares contam o texto decodificado e em NFC (o que fica
    /// na memória), não os bytes crus: dois pares ISO-8859-1 de 8 MiB e 6 MiB crus (16 MiB e 12 MiB
    /// em UTF-8) cabiam pelos bytes, mas o 2º não cabe pelo texto e fica de fora.
    #[test]
    fn spell_pair_memory_counts_the_decoded_text() {
        use crate::vault::dictionaries::ENGINE_MAX_PAIR_BYTES;
        const MIB: usize = 1024 * 1024;
        let world = World::new();
        for (name, size) in [("a", 8 * MIB), ("b", 6 * MIB)] {
            let mut dic = b"1\n".to_vec();
            dic.resize(size, 0xE9);
            world.global_file(&format!("{name}.txt"), PAIR_TERM.as_bytes());
            world.global_file(&format!("hunspell/{name}.aff"), b"SET ISO8859-1\n");
            world.global_file(&format!("hunspell/{name}.dic"), &dic);
        }
        let sources = world.global.engine_sources(None);
        let text: usize = sources
            .pairs
            .iter()
            .map(|pair| pair.aff.len() + pair.dic.len())
            .sum();
        assert_eq!((sources.pairs.len(), sources.skipped), (1, 1));
        assert!(text > 15 * MIB, "{text}");
        assert!(text as u64 <= ENGINE_MAX_PAIR_BYTES, "{text}");
    }

    /// AC-R34-3: a bomba de 39 B (`COMPOUNDFLAG` + `COMPOUNDMIN`) é recusada antes do parse, e a
    /// palavra de 64 letras que a explodiria passa em milissegundos.
    #[test]
    fn spell_ac3_compound_bomb_is_refused_before_the_parse() {
        let world = World::new();
        let bomb = b"COMPOUNDFLAG A\nCOMPOUNDMIN 2\nSET UTF-8\n";
        assert_eq!(bomb.len(), 39);
        world.global_file("bomba.txt", b"ab\n");
        world.global_file("hunspell/bomba.aff", bomb);
        world.global_file("hunspell/bomba.dic", b"3\na/A\nb/A\nab/A\n");
        let done = world.reload(false);
        assert_eq!(
            (done.pairs, done.skipped, done.refused.directive),
            (0, 1, 1)
        );
        let word = "ab".repeat(32);
        let started = Instant::now();
        assert_eq!(unknown(&world.spell, &[&word]), [0]);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// AC-R34-3: 50.000 SFX vazios cabem nas contagens e no trabalho por palavra (50.000 regras),
    /// mas reprovam no teste de velocidade.
    #[test]
    fn spell_ac3_a_slow_pair_fails_the_speed_test() {
        let world = World::new();
        let aff = String::from("SET UTF-8\nSFX A Y 50000\n") + &"SFX A 0 0 .\n".repeat(50_000);
        assert_eq!(vetted(&aff), Ok(()));
        world.global_file("lenta.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/lenta.aff", aff.as_bytes());
        world.global_file("hunspell/lenta.dic", "1\nzubênico/A\n".as_bytes());
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.slow), (0, 1, 1));
    }

    /// AppSec r34 B1 (a0-a2): o par que faz uma palavra custar p × n² no spellbook é recusado antes
    /// do parse pelo trabalho por palavra (`Rules`), num instante — nas escalas medidas pela AppSec
    /// e com os tetos cheios (1.000 PFX e 59.999 SFX, 1,1 MB). Com um PFX, o trabalho é
    /// 3n² + 9n + 8 regras: o limite fica entre n = 181 e 182. O pt_BR embutido: 5.798.
    #[test]
    fn spell_b1_a_pair_whose_word_costs_too_much_is_refused_before_the_parse() {
        for (p, n) in [
            (1, 500),
            (1, 1_000),
            (1, 2_000),
            (2, 2_000),
            (4, 2_000),
            (PFX_MAX, SFX_MAX - 1),
        ] {
            let aff = bomb(p, n);
            let started = Instant::now();
            assert_eq!(vetted(&aff), Err(Refusal::Rules), "p={p} n={n}");
            let elapsed = started.elapsed();
            assert!(elapsed < Duration::from_secs(2), "p={p} n={n}: {elapsed:?}");
        }
        assert_eq!(vetted(&bomb(1, 181)), Ok(()));
        assert_eq!(vetted(&bomb(1, 182)), Err(Refusal::Rules));
        let (shape, ignore) = read_aff(BASE_AFF).unwrap();
        assert_eq!(shape.work(&ignore).0, 5_798);

        let world = World::new();
        world.global_file("bomba.txt", b"abc\n");
        world.global_file("hunspell/bomba.aff", bomb(PFX_MAX, SFX_MAX - 1).as_bytes());
        world.global_file("hunspell/bomba.dic", BOMB_DIC.as_bytes());
        let started = Instant::now();
        let done = world.reload(false);
        let elapsed = started.elapsed();
        assert_eq!((done.pairs, done.skipped, done.refused.rules), (0, 1, 1));
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 0);
        println!("B1 a2 (1.000 PFX × 59.999 SFX): recarga recusou em {elapsed:?}, sem parse");
    }

    /// AppSec r34 B1 (a0): no maior par desse formato que o `vet_aff` aceita (n = 181), a palavra-
    /// gatilho custa pouco — conferi-la e sugerir para ela no par cabem com folga no prazo, e pelo
    /// motor a conferência e a sugestão voltam sem `TIMEOUT`, com os pares ligados.
    #[test]
    fn spell_b1_the_largest_accepted_shape_stays_within_the_deadline() {
        let aff = bomb(1, 181);
        assert_eq!(vetted(&aff), Ok(()));
        let pair = Dictionary::new(&aff, BOMB_DIC).unwrap();
        let started = Instant::now();
        assert!(!black_box(pair.check(TRIGGER)));
        let check = started.elapsed();
        let started = Instant::now();
        edits(&pair, TRIGGER, &mut Vec::new());
        let suggest = started.elapsed();
        assert!(
            check + suggest < LIMITS.check / 2,
            "check {check:?}, suggest {suggest:?}"
        );
        let spell = SpellState::default();
        install_unvetted(&spell, &[(&aff, BOMB_DIC)]);
        assert_eq!(unknown(&spell, &[TRIGGER, "casa"]), [0]);
        let generation = spell.next_suggestion();
        let found = spell.suggest(generation, TRIGGER, LIMITS.check);
        assert!(found.is_ok(), "{found:?}");
        assert!(spell.engine().pairs_on());
        println!("B1 a0 (1 PFX × 181 SFX, no par): check {check:?}, suggest {suggest:?}");
    }

    /// AppSec r34 B1 (b): um par dentro do trabalho por palavra (60.000 SFX `qq`: 60.000 regras)
    /// passa nas 128 palavras fixas, que não terminam em `qq`, mas não nas palavras de prova
    /// geradas dele (`xqq`, `xqqqq`, …): fica de fora como lento.
    #[test]
    fn spell_b1_the_probes_catch_a_pair_slow_only_on_its_own_words() {
        let aff = String::from("SET UTF-8\nSFX A Y 60000\n") + &"SFX A 0 qq .\n".repeat(60_000);
        let probes = vet_aff(&aff).unwrap().probes;
        assert!(probes.contains(&"xqq".to_owned()), "{probes:?}");
        assert!(probes.contains(&"xqqqq".to_owned()), "{probes:?}");
        let base = base().unwrap();
        let limit =
            timed(&base.dictionary, &CALIBRATION_WORDS, Duration::MAX).unwrap() * PAIR_SLOWDOWN;
        let pair = Dictionary::new(&aff, "1\nabc/A\n").unwrap();
        let fixed = timed(&pair, &CALIBRATION_WORDS, Duration::MAX).unwrap();
        assert!(fixed < limit.max(LIMITS.calibration_floor), "{fixed:?}");
        let world = World::new();
        world.global_file("lenta.txt", b"abc\n");
        world.global_file("hunspell/lenta.aff", aff.as_bytes());
        world.global_file("hunspell/lenta.dic", b"1\nabc/A\n");
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.slow), (0, 1, 1));
    }

    /// AppSec r34 B1 (a2, c): um par lento que escapasse das conferências (instalado direto) não
    /// prende quem pede. As consultas aos pares rodam numa thread só; quem pede mede o prazo e, no
    /// estouro, responde `TIMEOUT` e desliga o par; a base responde na hora enquanto a thread
    /// termina a palavra; uma recarga com o mesmo par espera na fila (de um) e estoura de novo; um
    /// pedido mais novo cancela o que espera; nunca nasce uma segunda thread.
    #[test]
    fn spell_b1_a_stuck_pair_times_out_and_holds_at_most_one_thread() {
        let aff = bomb(1, 2_000);
        let words = owned(&["casa", "texto", TRIGGER, "fim"]);
        let short = Duration::from_millis(20);
        let spell = Arc::new(SpellState::default());
        install_unvetted(&spell, &[(&aff, BOMB_DIC)]);
        let started = Instant::now();
        let generation = spell.next_check();
        let error = spell.check(generation, &words, short).unwrap_err();
        let first = started.elapsed();
        assert_eq!(error.code, "TIMEOUT");
        assert!(first < Duration::from_secs(1), "{first:?}");
        assert!(!spell.engine().pairs_on());

        // Par desligado: a base responde sem esperar a thread, que ainda está na palavra.
        let started = Instant::now();
        assert_eq!(unknown(&spell, &["casa", TRIGGER]), [1]);
        let base_only = started.elapsed();
        assert!(base_only < Duration::from_secs(1), "{base_only:?}");
        assert!(suggestions(&spell, "excessão").contains(&"exceção".to_owned()));

        // Outra recarga com o mesmo par: o pedido espera na fila, atrás da palavra, e estoura.
        install_unvetted(&spell, &[(&aff, BOMB_DIC)]);
        let started = Instant::now();
        let generation = spell.next_check();
        assert_eq!(code(spell.check(generation, &words, short)), "TIMEOUT");
        let queued = started.elapsed();
        assert!(queued < Duration::from_secs(1), "{queued:?}");

        // Um pedido mais novo cancela o que espera, sem esperar a thread.
        drain(&spell);
        install_unvetted(&spell, &[(&aff, BOMB_DIC)]);
        let older = spell.next_check();
        let waiting = {
            let (spell, words) = (Arc::clone(&spell), words.clone());
            thread::spawn(move || {
                let started = Instant::now();
                let result = spell.check(older, &words, LIMITS.check).map_err(|e| e.code);
                (result, started.elapsed())
            })
        };
        thread::sleep(Duration::from_millis(30));
        spell.next_check();
        let (result, cancelled) = waiting.join().unwrap();
        assert_eq!(result, Err("CANCELLED"));
        assert!(cancelled < Duration::from_secs(1), "{cancelled:?}");
        assert_eq!(spell.lookups.spawned.load(Ordering::SeqCst), 1);
        println!(
            "B1 a2 (1 PFX × 2.000 SFX, prazo {short:?}): TIMEOUT em {first:?}; base sem pares \
             {base_only:?}; na fila {queued:?}; CANCELLED em {cancelled:?}; 1 thread"
        );
    }

    /// AppSec r34 c1 B1' (3): a thread das consultas tem fila de um (`sync_channel(1)` +
    /// `try_send`). Com ela ocupada (aqui num trabalho que espera um portão) e um trabalho
    /// abandonado na fila, o `spell_check` e o `spell_suggest` seguintes respondem `TIMEOUT` na
    /// hora, sem esperar o prazo nem guardar o motor; o motor trocado numa recarga sai da memória com
    /// a thread ainda ocupada; aberto o portão, o trabalho abandonado é pulado e o motor novo
    /// responde. Uma thread só.
    #[test]
    fn spell_b1c1_the_lookup_queue_holds_one_job_and_a_busy_one_answers_at_once() {
        let spell = Arc::new(SpellState::default());
        let plural = std::str::from_utf8(PLURAL_AFF).unwrap();
        install_unvetted(&spell, &[(plural, PLURAL_DIC)]);
        let (entered, inside) = mpsc::channel();
        let (open, gate) = mpsc::channel::<()>();
        let occupied = {
            let spell = Arc::clone(&spell);
            thread::spawn(move || {
                let until = Instant::now() + Duration::from_secs(60);
                spell.lookups.call(
                    until,
                    || false,
                    move |_: &AtomicBool| {
                        let _ = entered.send(());
                        let _ = gate.recv();
                    },
                )
            })
        };
        inside.recv().unwrap();

        // A fila está livre: o pedido entra nela e estoura no prazo (ninguém em consulta).
        let generation = spell.next_check();
        let words = owned(&["zubênicos"]);
        let error = spell
            .check(generation, &words, Duration::from_millis(20))
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        // Fila ocupada pelo trabalho abandonado: o seguinte volta na hora, longe do prazo de 3 s.
        let started = Instant::now();
        let generation = spell.next_check();
        assert_eq!(
            code(spell.check(generation, &words, LIMITS.check)),
            "TIMEOUT"
        );
        let busy_check = started.elapsed();
        let started = Instant::now();
        let generation = spell.next_suggestion();
        assert_eq!(
            code(spell.suggest(generation, "zubênicoss", LIMITS.check)),
            "TIMEOUT"
        );
        let busy_suggest = started.elapsed();
        assert!(busy_check < Duration::from_secs(1), "{busy_check:?}");
        assert!(busy_suggest < Duration::from_secs(1), "{busy_suggest:?}");
        assert_eq!(on(&spell), [true], "nenhum par segurava a thread");

        // Recarga: o motor e o par trocados saem da memória; a fila só tem referências fracas.
        let (engine, pair) = {
            let engine = spell.engine();
            (Arc::downgrade(&engine), Arc::downgrade(&engine.pairs[0]))
        };
        install_unvetted(&spell, &[(plural, PLURAL_DIC)]);
        assert!(engine.upgrade().is_none());
        assert!(pair.upgrade().is_none());

        open.send(()).unwrap();
        assert_eq!(occupied.join().unwrap(), Ok(()));
        drain(&spell);
        assert_eq!(unknown(&spell, &["zubênicos", "zubênicoss"]), [1]);
        assert_eq!(spell.lookups.spawned.load(Ordering::SeqCst), 1);
        println!(
            "B1' fila de um: ocupada → check TIMEOUT em {busy_check:?}, suggest em {busy_suggest:?}"
        );
    }

    /// AppSec r34 c1 B1' (3, 4): com a fila ocupada, o pedido que volta na hora só desliga o par em
    /// consulta se ele já segura a thread há mais que o prazo do pedido (3 s: nenhum; 20 ms: o par
    /// lento) — nunca o outro par. Depois que a thread termina a palavra, o par global responde e o
    /// lento nem é consultado.
    #[test]
    fn spell_b1c1_a_busy_queue_turns_off_only_a_pair_held_past_the_deadline() {
        let spell = Arc::new(SpellState::default());
        let plural = std::str::from_utf8(PLURAL_AFF).unwrap();
        install_unvetted(&spell, &[(plural, PLURAL_DIC), (&bomb(2, 2_000), BOMB_DIC)]);
        let slow = Arc::downgrade(&spell.engine().pairs[1]);
        // Um pedido preso no par lento…
        let first = {
            let (spell, words) = (Arc::clone(&spell), owned(&[TRIGGER]));
            let generation = spell.next_check();
            thread::spawn(move || {
                spell
                    .check(generation, &words, LIMITS.check)
                    .map_err(|e| e.code)
            })
        };
        let until = Instant::now() + Duration::from_secs(10);
        while !spell
            .holder
            .0
            .lock()
            .as_ref()
            .is_some_and(|(held, _)| held.ptr_eq(&slow))
        {
            assert!(Instant::now() < until, "a thread não chegou ao par lento");
            thread::sleep(Duration::from_millis(1));
        }
        // …e a fila ocupada (o trabalho de um pedido que desistiu).
        let queue = spell.lookups.queue.lock();
        assert!(queue.as_ref().unwrap().try_send(Box::new(|| ())).is_ok());
        drop(queue);

        let started = Instant::now();
        let generation = spell.next_check();
        let words = owned(&[TRIGGER]);
        assert_eq!(
            code(spell.check(generation, &words, LIMITS.check)),
            "TIMEOUT"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(on(&spell), [true, true], "preso há menos que 3 s");
        thread::sleep(Duration::from_millis(30));
        let generation = spell.next_check();
        let fourth = spell.check(generation, &words, Duration::from_millis(20));
        assert_eq!(code(fourth), "TIMEOUT");
        assert_eq!(on(&spell), [true, false], "preso há mais que 20 ms");
        assert_eq!(first.join().unwrap(), Err("CANCELLED"));
        drain(&spell);
        let started = Instant::now();
        assert_eq!(unknown(&spell, &["zubênicos", TRIGGER]), [1]);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// AppSec r34 c1 B1' (a4): `ICONV ж` com troca de 3.964 caracteres (3.900 `y` + 64 `q`) e
    /// 25.000 SFX `q×64` — 2,0 MB, dentro dos tetos de antes; o spellbook mede a palavra antes do
    /// `ICONV`, e cada `ж` vira 3.964 caracteres — cai antes do parse (`Rules`: troca acima de 8),
    /// sem thread. Com a troca no teto (8 `q`), o par passa no `vet_aff`, mas as provas do `ICONV`
    /// (`ж` repetido) o derrubam no teste de velocidade; pelo motor, `check` e `suggest` com `ж`
    /// respondem pela base, no prazo. E no par sem conferência, uma palavra com `ж` chega ao motor
    /// com até 512 caracteres: custo limitado.
    #[test]
    fn spell_b1c1_a4_a_long_iconv_is_refused_and_one_at_the_cap_stays_bounded() {
        use crate::vault::dictionaries::PAIR_AFF_MAX_BYTES;
        let wide = a4(&format!("{}{}", "y".repeat(3_900), "q".repeat(64)));
        let size = wide.len();
        assert!(
            size > 1_900_000 && size as u64 <= PAIR_AFF_MAX_BYTES,
            "{size}"
        );
        let started = Instant::now();
        assert_eq!(vetted(&wide), Err(Refusal::Rules));
        let refused = started.elapsed();
        let capped = a4("qqqqqqqq");
        let probes = vet_aff(&capped).unwrap().probes;
        assert!(probes.contains(&"ж".repeat(64)), "{probes:?}");

        let world = World::new();
        world.global_file("a4.txt", b"abc\n");
        world.global_file("hunspell/a4.aff", wide.as_bytes());
        world.global_file("hunspell/a4.dic", b"1\nabc/A\n");
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.rules), (0, 1, 1));
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 0);
        world.global_file("hunspell/a4.aff", capped.as_bytes());
        let started = Instant::now();
        let done = world.reload(false);
        let reload = started.elapsed();
        assert_eq!((done.pairs, done.skipped, done.refused.slow), (0, 1, 1));

        let long = "ж".repeat(64);
        let started = Instant::now();
        let generation = world.spell.next_check();
        let words = owned(&["ж", long.as_str()]);
        let found = world.spell.check(generation, &words, LIMITS.check);
        assert_eq!(found.unwrap(), [0, 1]);
        let generation = world.spell.next_suggestion();
        assert!(world.spell.suggest(generation, "ж", LIMITS.check).is_ok());
        let engine = started.elapsed();
        assert!(engine < Duration::from_secs(1), "{engine:?}");

        let pair = Dictionary::new(&capped, "1\nabc/A\n").unwrap();
        let mut checks = Vec::new();
        for k in [1, 4, 16, 64] {
            let word = "ж".repeat(k);
            let started = Instant::now();
            assert!(!black_box(pair.check(&word)));
            checks.push(started.elapsed());
        }
        let started = Instant::now();
        edits(&pair, "ж", &mut Vec::new());
        let suggest = started.elapsed();
        assert!(
            checks.iter().all(|check| *check < Duration::from_secs(1)),
            "{checks:?}"
        );
        assert!(suggest < Duration::from_secs(1), "{suggest:?}");
        println!(
            "B1' a4 ({size} B): recusado em {refused:?}, sem parse; no teto, recarga recusou \
             (lento) em {reload:?}; motor com ж (check + suggest) {engine:?}; no par, check \
             ж×1/4/16/64 {checks:?}, suggest ж {suggest:?}"
        );
    }

    /// AppSec r34 c1 B1' (a5): um `TRY` de 4 KiB — dentro da linha de 4 KiB; a sugestão por edição
    /// tenta cada letra dele em cada posição — cai antes do parse (`Rules`: mais de 128), como o
    /// mesmo `KEY`, sem thread; com 128 letras, o par carrega e responde.
    #[test]
    fn spell_b1c1_a5_a_4_kib_try_is_refused() {
        let letters = |n: usize| ('a'..='z').cycle().take(n).collect::<String>();
        let a5 = format!(
            "SET UTF-8\nTRY {}\nSFX S Y 1\nSFX S 0 s .\n",
            letters(4_092)
        );
        assert_eq!(a5.lines().nth(1).unwrap().len(), LINE_MAX_BYTES);
        let started = Instant::now();
        assert_eq!(vetted(&a5), Err(Refusal::Rules));
        let refused = started.elapsed();
        assert_eq!(vetted(&a5.replacen("TRY", "KEY", 1)), Err(Refusal::Rules));
        let world = World::new();
        world.global_file("a5.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/a5.aff", a5.as_bytes());
        world.global_file("hunspell/a5.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.rules), (0, 1, 1));
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 0);
        let at_cap = a5.replace(&letters(4_092), &letters(128));
        world.global_file("hunspell/a5.aff", at_cap.as_bytes());
        assert_eq!(world.reload(false).pairs, 1);
        assert!(unknown(&world.spell, &["zubênicos"]).is_empty());
        println!("B1' a5 (TRY de 4 KiB): recusado em {refused:?}, sem parse");
    }

    /// AppSec r34 c1 B1' (2): cada palavra de prova tem o próprio limite — mil padrões baratos de
    /// `ICONV` não abrem folga para a prova lenta do a4 no teto (`ж` repetido) passar.
    #[test]
    fn spell_b1c1_a_slow_probe_cannot_hide_among_cheap_ones() {
        let cheap: String = (0..999u32)
            .filter_map(|i| char::from_u32(0x4E00 + i))
            .map(|c| format!("ICONV {c} a\n"))
            .collect();
        let aff = a4("qqqqqqqq").replacen(
            "ICONV 1\nICONV ж qqqqqqqq\n",
            &format!("ICONV 1000\nICONV ж qqqqqqqq\n{cheap}"),
            1,
        );
        let probes = vet_aff(&aff).unwrap().probes;
        assert!(probes.len() > 1_000, "{}", probes.len());
        let world = World::new();
        world.global_file("a4.txt", b"abc\n");
        world.global_file("hunspell/a4.aff", aff.as_bytes());
        world.global_file("hunspell/a4.dic", b"1\nabc/A\n");
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.slow), (0, 1, 1));
    }

    /// AppSec r34 c1 B1' (2): a palavra de prova mais lenta (`slowest_probe`) vai à sugestão de
    /// prova, que roda na thread de parse com prazo: estourada, o par fica de fora (`Slow`) sem a
    /// recarga esperar o fim dela; a thread, ocupada até lá, aceita um trabalho na fila (que estoura
    /// no prazo) e recusa na hora o seguinte (`Timeout`).
    #[test]
    fn spell_b1c1_the_test_suggestion_runs_on_the_slowest_probe_with_a_deadline() {
        let aff = bomb(1, 600);
        let pair = Dictionary::new(&aff, BOMB_DIC).unwrap();
        let words = owned(&["casa", "x", TRIGGER, "xqq"]);
        assert_eq!(slowest_probe(&pair, &words, Duration::MAX), Some(2));
        let spell = SpellState::default();
        let ticket = spell.next_reload();
        let short = || Instant::now() + Duration::from_millis(20);
        let started = Instant::now();
        let tested = spell.suggest_within(ticket, pair, TRIGGER.to_owned(), short());
        assert!(matches!(tested, Err(Refusal::Slow)));
        let slow = started.elapsed();
        assert!(slow < Duration::from_secs(1), "{slow:?}");
        let (aff, dic) = (PLURAL_AFF.to_vec(), PLURAL_DIC.to_owned());
        let aff = String::from_utf8(aff).unwrap();
        let queued = spell.parse_within(ticket, aff.clone(), dic.clone(), short());
        assert!(matches!(queued, Err(Refusal::Timeout)));
        let started = Instant::now();
        let far = Instant::now() + LIMITS.check;
        assert!(matches!(
            spell.parse_within(ticket, aff, dic, far),
            Err(Refusal::Timeout)
        ));
        let busy = started.elapsed();
        assert!(busy < Duration::from_secs(1), "{busy:?}");
        assert_eq!(spell.parses.spawned.load(Ordering::SeqCst), 1);
        println!("B1' sugestão de prova: Slow em {slow:?}; thread ocupada → Timeout em {busy:?}");
    }

    /// AppSec r34 B2 (a3): o `.dic` com uma palavra mais de 16 vezes é recusado antes do parse,
    /// contada como o spellbook a guarda — com flags, outra caixa, campo morfológico, TAB, espaço
    /// nas pontas e os caracteres do `IGNORE`; comentário e `\/` (que vira `/`) não são a mesma
    /// palavra. O 1.000.000 de "zz" da AppSec (3 MB) sai num instante, sem parse. O pt_BR passa.
    #[test]
    fn spell_b2_a_word_repeated_more_than_16_times_is_refused() {
        let dic = |lines: &[&str]| format!("{}\n{}\n", lines.len(), lines.join("\n"));
        let sixteen = vec!["zz"; 16];
        assert!(prepare_dic(&dic(&sixteen), &[]).is_ok());
        for extra in [
            "zz",
            "zz/AB",
            "ZZ",
            "Zz",
            "zz po:subst",
            "zz\tnota",
            "  zz  ",
        ] {
            let lines: Vec<&str> = sixteen.iter().copied().chain([extra]).collect();
            assert_eq!(
                prepare_dic(&dic(&lines), &[]),
                Err(Refusal::Lines),
                "{extra:?}"
            );
        }
        for other in ["# zz", "#zz", r"z\/z", "zz zz"] {
            let lines: Vec<&str> = sixteen.iter().copied().chain([other]).collect();
            assert!(prepare_dic(&dic(&lines), &[]).is_ok(), "{other:?}");
        }
        let lines: Vec<&str> = sixteen.iter().copied().chain(["zaz"]).collect();
        assert!(prepare_dic(&dic(&lines), &[]).is_ok());
        assert_eq!(prepare_dic(&dic(&lines), &['a']), Err(Refusal::Lines));
        assert!(prepare_dic(BASE_DIC, &[]).is_ok());

        let n = DIC_MAX_LINES - 1;
        let appsec = format!("{n}\n{}", "zz\n".repeat(n));
        let started = Instant::now();
        assert_eq!(prepare_dic(&appsec, &[]), Err(Refusal::Lines));
        let refused = started.elapsed();
        assert!(refused < Duration::from_secs(2), "{refused:?}");
        let world = World::new();
        world.global_file("zz.txt", b"zz\n");
        world.global_file("hunspell/zz.aff", b"SET UTF-8\n");
        world.global_file("hunspell/zz.dic", appsec.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.lines), (0, 1, 1));
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 0);
        println!("B2 a3 (1.000.000 × \"zz\"): recusado em {refused:?}, sem parse");
    }

    /// AppSec r34 B2: o parse que passa do prazo deixa o par de fora (por par ou o da recarga); com
    /// o prazo já vencido nenhuma thread de parse nasce; e os parses rodam numa thread só — dois
    /// pares de parse mais longo que o prazo saem os dois, o 2º pulado na fila.
    #[test]
    fn spell_ac3_a_parse_past_the_deadline_is_refused() {
        let world = World::new();
        world.global_file("zub.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/zub.aff", PLURAL_AFF);
        world.global_file("hunspell/zub.dic", PLURAL_DIC.as_bytes());
        for limits in [
            Limits {
                pair_parse: Duration::ZERO,
                ..LIMITS
            },
            Limits {
                reload_parse: Duration::ZERO,
                ..LIMITS
            },
        ] {
            let done = world.reload_with(false, limits);
            assert_eq!((done.pairs, done.skipped, done.refused.timeout), (0, 1, 1));
        }
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 0);
        assert_eq!(world.reload(false).pairs, 1);
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 1);

        let world = World::new();
        let mut dic = String::from("100000\n");
        for n in 0..100_000u32 {
            let _ = writeln!(dic, "w{n:06}x");
        }
        for name in ["a", "b"] {
            world.global_file(&format!("{name}.txt"), PAIR_TERM.as_bytes());
            world.global_file(&format!("hunspell/{name}.aff"), PLURAL_AFF);
            world.global_file(&format!("hunspell/{name}.dic"), dic.as_bytes());
        }
        let limits = Limits {
            pair_parse: Duration::from_millis(1),
            ..LIMITS
        };
        let done = world.reload_with(false, limits);
        assert_eq!((done.pairs, done.skipped, done.refused.timeout), (0, 2, 2));
        assert_eq!(world.spell.parses.spawned.load(Ordering::SeqCst), 1);
    }

    /// AC-R34-3: o `BREAK` de um par é ignorado (o par roda com `BREAK 0`).
    #[test]
    fn spell_ac3_the_break_of_a_pair_is_ignored() {
        let aff = "SET UTF-8\nBREAK 1\nBREAK _\n";
        assert!(Dictionary::new(aff, "1\nzubqx\n")
            .unwrap()
            .check("zubqx_zubqx"));
        let world = World::new();
        world.global_file("quebra.txt", b"zubqx\n");
        world.global_file("hunspell/quebra.aff", aff.as_bytes());
        world.global_file("hunspell/quebra.dic", b"1\nzubqx\n");
        assert_eq!(world.reload(false).pairs, 1);
        assert_eq!(unknown(&world.spell, &["zubqx", "zubqx_zubqx"]), [1]);
    }

    /// AC-R34-3: contagens do `.aff` (PFX, SFX, continuação, condição, MAP, REP, ICONV, OCONV),
    /// tamanhos (AppSec r34 c1 B1': `tira` e `põe` até 64 caracteres, sem as flags; troca de
    /// ICONV/OCONV até 8 e de REP até 16; `TRY` e `KEY` até 128 — caracteres, não bytes), linha,
    /// diretivas recusadas (também depois do BOM) e tabela malformada — no limite passa, um acima
    /// reprova. O pt_BR embutido passa.
    #[test]
    fn spell_ac3_aff_caps_and_refused_directives() {
        let affix = |key: &str, flag: &str, row: &str, n: usize| {
            format!("{key} {flag} Y {n}\n") + &format!("{key} {flag} {row}\n").repeat(n)
        };
        let table = |key: &str, row: &str, n: usize| {
            format!("{key} {n}\n") + &format!("{key} {row}\n").repeat(n)
        };
        for (ok, over) in [
            (
                affix("PFX", "A", "0 x .", 1_000),
                affix("PFX", "A", "0 x .", 1_001),
            ),
            (
                affix("PFX", "A", "0 x .", 500) + &affix("PFX", "B", "0 y .", 500),
                affix("PFX", "A", "0 x .", 500) + &affix("PFX", "B", "0 y .", 501),
            ),
            (
                affix("SFX", "A", "0 x .", 60_000),
                affix("SFX", "A", "0 x .", 60_001),
            ),
            (
                affix("SFX", "A", "0 x/B .", 100),
                affix("SFX", "A", "0 x/B .", 101),
            ),
            (
                affix("SFX", "A", &format!("0 x {}", "a".repeat(256)), 1),
                affix("SFX", "A", &format!("0 x {}", "a".repeat(257)), 1),
            ),
            (table("MAP", "aá", 64), table("MAP", "aá", 65)),
            (table("REP", "a b", 5_000), table("REP", "a b", 5_001)),
            (table("ICONV", "a b", 1_000), table("ICONV", "a b", 1_001)),
            (table("OCONV", "a b", 1_000), table("OCONV", "a b", 1_001)),
            (
                affix("SFX", "A", &format!("0 {} .", "x".repeat(64)), 1),
                affix("SFX", "A", &format!("0 {} .", "x".repeat(65)), 1),
            ),
            (
                affix("SFX", "A", &format!("0 {}/B .", "ç".repeat(64)), 1),
                affix("SFX", "A", &format!("0 {}/B .", "ç".repeat(65)), 1),
            ),
            (
                affix("PFX", "A", &format!("{} 0 .", "á".repeat(64)), 1),
                affix("PFX", "A", &format!("{} 0 .", "á".repeat(65)), 1),
            ),
            (
                table("ICONV", &format!("a {}", "b".repeat(8)), 1),
                table("ICONV", &format!("a {}", "b".repeat(9)), 1),
            ),
            (
                table("OCONV", &format!("a {}", "ж".repeat(8)), 1),
                table("OCONV", &format!("a {}", "ж".repeat(9)), 1),
            ),
            (
                table("REP", &format!("a {}", "b_".repeat(8)), 1),
                table("REP", &format!("a {}b", "b_".repeat(8)), 1),
            ),
            (
                format!("TRY {}\n", "á".repeat(128)),
                format!("TRY {}\n", "á".repeat(129)),
            ),
            (
                format!("KEY {}\n", "q".repeat(128)),
                format!("KEY {}\n", "q".repeat(129)),
            ),
        ] {
            assert_eq!(vetted(&ok), Ok(()));
            assert_eq!(vetted(&over), Err(Refusal::Rules));
        }
        assert_eq!(
            vetted(&format!("TRY {}\n", "a".repeat(4_093))),
            Err(Refusal::Lines)
        );
        for directive in [
            "COMPOUNDFLAG A",
            "COMPOUNDBEGIN A",
            "COMPOUNDRULE 1",
            "COMPOUNDMIN 1",
            "ONLYINCOMPOUND A",
            "CHECKCOMPOUNDPATTERN 1",
            "CHECKCOMPOUNDDUP",
            "CIRCUMFIX A",
            "COMPLEXPREFIXES",
            "AF 1",
            "\u{FEFF}COMPOUNDFLAG A",
            "  # comentário\nCOMPOUNDFLAG A",
        ] {
            assert_eq!(vetted(directive), Err(Refusal::Directive), "{directive}");
        }
        assert_eq!(vetted("# COMPOUNDFLAG A\n"), Ok(()));
        for broken in [
            "PFX A Y 2\nPFX A 0 x .\n",
            "REP x\n",
            "SFX A Y 1\n\nSFX A 0 s .\n",
        ] {
            assert_eq!(vetted(broken), Err(Refusal::Parse), "{broken}");
        }
        assert_eq!(vetted(BASE_AFF), Ok(()));
    }

    /// AppSec r34 B1: a flag de continuação é lida com o `FLAG` vigente na tabela (um byte, dois
    /// caracteres, número ou UTF-16), como no spellbook — 400 SFX `qq` alvos de um `qq/<flag>` dão
    /// 161.603 regras (recusado); a mesma grafia que só casaria byte a byte, nenhuma (aceito) —, e
    /// o `IGNORE` sai dos `add` antes da conta: metade dos `add` disfarçados (`qqê`) com
    /// `IGNORE ê` volta a ser o par recusado.
    #[test]
    fn spell_b1_the_work_follows_the_flag_type_and_the_ignore() {
        let shaped = |flags: &str, (outer, inner, continuation): (&str, &str, &str), tail: &str| {
            let mut aff = format!("SET UTF-8\n{flags}SFX {outer} Y 400\n");
            for i in 0..400 {
                let tail = if i % 2 == 0 { "" } else { tail };
                let _ = writeln!(aff, "SFX {outer} 0 qq{tail} .");
            }
            let _ = writeln!(aff, "SFX {inner} Y 1\nSFX {inner} 0 qq/{continuation} .");
            aff
        };
        for (flags, same, other) in [
            ("", ("A", "B", "A"), ("A", "B", "C")),
            ("FLAG long\n", ("AB", "CD", "AB"), ("AB", "CD", "BA")),
            ("FLAG num\n", ("1", "2", "1"), ("1", "2", "10")),
            ("FLAG UTF-8\n", ("Á", "É", "Á"), ("Á", "É", "Ã")),
        ] {
            assert_eq!(
                vetted(&shaped(flags, same, "")),
                Err(Refusal::Rules),
                "{flags:?} {same:?}"
            );
            assert_eq!(
                vetted(&shaped(flags, other, "")),
                Ok(()),
                "{flags:?} {other:?}"
            );
        }
        let disguised = shaped("", ("A", "B", "A"), "ê");
        assert_eq!(vetted(&disguised), Ok(()));
        assert_eq!(
            vetted(&format!("IGNORE ê\n{disguised}")),
            Err(Refusal::Rules)
        );
    }

    /// AC-R34-3: o `.dic` de um par — até 1.000.000 de linhas de até 4 KiB; a contagem declarada
    /// (a reserva de memória do spellbook) vira a real; sem contagem → recusado. O pt_BR passa.
    #[test]
    fn spell_ac3_dic_caps_and_the_declared_count() {
        assert_eq!(
            prepare_dic("2\nzub\nzux\n", &[]).as_deref(),
            Ok("2\nzub\nzux\n")
        );
        assert_eq!(
            prepare_dic("# c\n999999999\nzub\n", &[]).as_deref(),
            Ok("3\nzub\n")
        );
        assert_eq!(prepare_dic("zub\n", &[]), Err(Refusal::Parse));
        assert_eq!(prepare_dic("", &[]), Err(Refusal::Parse));
        assert!(prepare_dic(&format!("1\n{}\n", "z".repeat(4_096)), &[]).is_ok());
        assert_eq!(
            prepare_dic(&format!("1\n{}\n", "z".repeat(4_097)), &[]),
            Err(Refusal::Lines)
        );
        let distinct = |n: usize| {
            (0..n).fold(String::from("1\n"), |mut dic, i| {
                let _ = writeln!(dic, "z{i}");
                dic
            })
        };
        assert!(prepare_dic(&distinct(999_999), &[]).is_ok());
        assert_eq!(prepare_dic(&distinct(1_000_000), &[]), Err(Refusal::Lines));
        assert!(prepare_dic(BASE_DIC, &[]).is_ok());
    }

    /// A base embutida carrega e a linha `TRY` vai para o dicionário dos termos; um `.aff` quebrado
    /// não vira base.
    #[test]
    fn spell_embedded_base_loads_and_a_broken_one_does_not() {
        let base = base().unwrap();
        assert!(base.try_chars.starts_with("áàãâéêíóõôúüç"));
        assert!(load_base("PFX A Y x\n", "1\nzub\n").is_err());
    }
}
