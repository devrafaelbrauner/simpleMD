//! Corretor ortográfico offline (r34, fatia 9 do p26; design-r34 §1, D-R34-1..7). Motor compatível
//! com o Hunspell (`spellbook` 0.4.2, MPL-2.0; D-P26-07) com o pt_BR do VERO embutido no binário
//! (`include_str!`, D-R34-1: os mesmos bytes em teste, dev e release; LibreOffice/dictionaries no
//! commit de D-R34-2, licença eleita MPL-2.0, texto em `dictionaries/MPL-2.0.txt`) mais as camadas do
//! usuário (D-P26-03), lidas por `vault::dictionaries` (`GlobalDictionaries::engine_sources`): os
//! termos `.txt` da camada global e da pasta num dicionário próprio (D-R34-5) e os pares
//! `.dic`/`.aff` das listas importadas (r33), entrada NÃO confiável (AppSec r33a N5, D-R34-4).
//!
//! Três comandos (D-R34-2), cada um numa thread de bloqueio (`vault::blocking`):
//! - `spell_check { lang, words }` → os índices das palavras que nem a base, nem os termos, nem os
//!   pares conhecem. Só `pt-BR` (`UNSUPPORTED_LANG`); mais de 20.000 → `TOO_MANY_WORDS { max }`. A
//!   palavra vai a NFC (D-R34-6); a que não é termo v1 (vazia, mais de 64 caracteres, espaço, Cc ou
//!   Cf) nunca é marcada. O pedido mais novo vence: o anterior para com `CANCELLED` (conferido a cada
//!   palavra) e `words: []` só cancela (devolve `[]`). Passou de 3 s → `TIMEOUT { seconds }` e os
//!   pares ficam desligados até o próximo `spell_reload`.
//! - `spell_suggest { lang, word }` → até 5 sugestões: as edições da base, dos termos e dos pares,
//!   nessa ordem; o n-grama da base (lento) só se nenhuma delas trouxer palavra única; palavra única
//!   antes de forma com espaço (D-R34-7). Um cálculo por vez; o pedido mais novo vence (`CANCELLED`).
//! - `spell_reload { token? }` → `{ langs, words, pairs, skipped }`: a base carrega no primeiro
//!   pedido de qualquer comando (`LazyLock`); relê a camada global e, com `token`, a da pasta
//!   (`VaultState::root`: `NO_VAULT`, `VAULT_CLOSED`) e troca as camadas de uma vez (`Arc`). Recarga
//!   mais nova vence (`CANCELLED`).
//!
//! Par não confiável (D-R34-4), antes do parse: linha até 4 KiB, `.dic` até 1.000.000 de linhas (e a
//! contagem da 1ª linha, que o spellbook usa para reservar memória, trocada pelo número real);
//! recusa compostos (`COMPOUND*`, `CHECKCOMPOUND*`, `ONLYINCOMPOUND`), `CIRCUMFIX`,
//! `COMPLEXPREFIXES` e `AF` (cada alias é copiado para cada linha do `.dic`: memória multiplicada);
//! ignora o `BREAK` (recursivo: o par roda com `BREAK 0`); até 1.000 PFX, 60.000 SFX, 100 deles com
//! continuação, condição até 256 bytes, 64 MAP, 5.000 REP, 1.000 ICONV e 1.000 OCONV. O parse roda
//! numa thread com prazo (2 s por par, 10 s por recarga) e o par passa por um teste de velocidade
//! (128 palavras: até 20× o tempo da base, piso 5 ms; os pares juntos até 40×, piso 10 ms), senão
//! fica de fora (`SLOW`). Nada disso vai ao webview além de `skipped`.
//!
//! Nada sai pela rede: só cálculo e a leitura das camadas (o `check:security` reprova `reqwest`,
//! `TcpStream`, `UdpSocket` e `://` no código daqui). Logs: uma linha por pedido, com o código, o
//! tempo e contagens; nunca palavra, nome de arquivo ou caminho. Um pânico do spellbook vira `IO`
//! (`vault::blocking`) ou, no parse de um par, a recusa do par.

use std::hint::black_box;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use spellbook::Dictionary;
use tauri::State;

use crate::error::AppError;
use crate::vault::dictionaries::{checkable_word, EnginePair, GlobalDictionaries};
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
/// Linha de um `.aff` ou `.dic` de par (D-R34-4).
const LINE_MAX_BYTES: usize = 4 * 1024;
/// Linhas de um `.dic` de par (D-R34-4).
const DIC_MAX_LINES: usize = 1_000_000;
/// Regras de um `.aff` de par (D-R34-4; o pt_BR tem 116 PFX, 25.713 SFX, 26 com continuação e 6
/// MAP).
const PFX_MAX: usize = 1_000;
const SFX_MAX: usize = 60_000;
const CONTINUATION_MAX: usize = 100;
const CONDITION_MAX_BYTES: usize = 256;
const MAP_MAX: usize = 64;
const REP_MAX: usize = 5_000;
const CONV_MAX: usize = 1_000;
/// Teste de velocidade de um par (D-R34-4): até 20× o tempo da base; os pares juntos até 40×.
const PAIR_SLOWDOWN: u32 = 20;
const PAIRS_SLOWDOWN: u32 = 40;
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
    /// Um `spell_check` (e a parte dos pares de um `spell_suggest`): estourou → pares desligados.
    check: Duration,
    /// O parse de um par.
    pair_parse: Duration,
    /// O parse de todos os pares de uma recarga (o que sobra dele também limita o de cada par).
    reload_parse: Duration,
    /// Piso do teste de velocidade de um par (o dos pares juntos é o dobro).
    calibration_floor: Duration,
}

const LIMITS: Limits = Limits {
    check: Duration::from_secs(3),
    pair_parse: Duration::from_secs(2),
    reload_parse: Duration::from_secs(10),
    calibration_floor: Duration::from_millis(5),
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
    pairs: Vec<Dictionary>,
    /// Pares desligados por estouro de prazo (D-R34-4), até a próxima recarga.
    pairs_off: AtomicBool,
}

impl Engine {
    fn knows(&self, base: &Base, word: &str) -> bool {
        base.dictionary.check(word)
            || self.terms.as_ref().is_some_and(|terms| terms.check(word))
            || (self.pairs_on() && self.pairs.iter().any(|pair| pair.check(word)))
    }

    fn pairs_on(&self) -> bool {
        !self.pairs_off.load(Ordering::SeqCst)
    }
}

/// Estado do corretor (no app, num `Arc`): as camadas da última recarga e as gerações dos pedidos
/// (o mais novo vence).
#[derive(Default)]
pub struct SpellState {
    engine: Mutex<Arc<Engine>>,
    checks: AtomicU64,
    suggestions: AtomicU64,
    reloads: AtomicU64,
    /// Uma sugestão por vez (o spellbook não é interrompível).
    suggesting: Mutex<()>,
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
    /// Linha acima de 4 KiB ou `.dic` acima de 1.000.000 de linhas.
    Lines,
    /// Diretiva recusada (composto, circunfixo, prefixos complexos, alias de flags).
    Directive,
    /// Regras demais ou condição longa.
    Rules,
    /// O spellbook recusou o par (ou entrou em pânico no parse).
    Parse,
    /// O parse passou do prazo.
    Timeout,
    /// Reprovou no teste de velocidade.
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

    /// Os índices das palavras fora da base, dos termos e dos pares. Para com `CANCELLED` se outro
    /// `spell_check` chegou e com `TIMEOUT` (desligando os pares desta recarga) depois de `deadline`.
    fn check(
        &self,
        generation: u64,
        words: &[String],
        deadline: Duration,
    ) -> Result<Vec<u32>, AppError> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let base = base()?;
        let engine = self.engine();
        let started = Instant::now();
        let mut unknown = Vec::new();
        for (index, word) in words.iter().enumerate() {
            if self.checks.load(Ordering::SeqCst) != generation {
                return Err(cancelled());
            }
            if started.elapsed() >= deadline {
                engine.pairs_off.store(true, Ordering::SeqCst);
                return Err(timeout(deadline));
            }
            if let Some(word) = checkable_word(word) {
                if !engine.knows(base, &word) {
                    unknown.push(index as u32);
                }
            }
        }
        Ok(unknown)
    }

    /// Até 5 sugestões (D-R34-7): as edições da base, dos termos e dos pares, nessa ordem; o
    /// n-grama da base (que relê a lista inteira) só se nenhuma edição trouxer palavra única; palavra
    /// única antes de forma com espaço; sem repetidas. Uma por vez; um pedido mais novo →
    /// `CANCELLED`. Os pares que passam de `deadline` ficam desligados até a próxima recarga.
    fn suggest(
        &self,
        generation: u64,
        word: &str,
        deadline: Duration,
    ) -> Result<Vec<String>, AppError> {
        let base = base()?;
        let _one = self.suggesting.lock();
        if self.suggestions.load(Ordering::SeqCst) != generation {
            return Err(cancelled());
        }
        let Some(word) = checkable_word(word) else {
            return Ok(Vec::new());
        };
        let engine = self.engine();
        let mut found = Vec::new();
        let mut batch = Vec::new();
        let edits = |dictionary: &Dictionary, batch: &mut Vec<String>| {
            dictionary
                .suggester()
                .with_ngram_suggestions(false)
                .suggest(&word, batch);
        };
        edits(&base.dictionary, &mut batch);
        merge(&mut found, &mut batch);
        if let Some(terms) = &engine.terms {
            edits(terms, &mut batch);
            merge(&mut found, &mut batch);
        }
        if engine.pairs_on() {
            let started = Instant::now();
            for pair in &engine.pairs {
                edits(pair, &mut batch);
                merge(&mut found, &mut batch);
            }
            if started.elapsed() >= deadline {
                engine.pairs_off.store(true, Ordering::SeqCst);
            }
        }
        if found.iter().all(|s| s.contains(' ')) {
            base.dictionary.suggest(&word, &mut batch);
            merge(&mut found, &mut batch);
        }
        if self.suggestions.load(Ordering::SeqCst) != generation {
            return Err(cancelled());
        }
        let (mut single, spaced): (Vec<String>, Vec<String>) =
            found.into_iter().partition(|s| !s.contains(' '));
        single.extend(spaced);
        single.truncate(MAX_SUGGESTIONS);
        Ok(single)
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
        let base_time = timed(&base.dictionary, Duration::MAX).unwrap_or_default();
        let pair_limit = (base_time * PAIR_SLOWDOWN).max(limits.calibration_floor);
        let mut pairs_left = (base_time * PAIRS_SLOWDOWN).max(limits.calibration_floor * 2);
        let started = Instant::now();
        let mut pairs = Vec::new();
        for pair in sources.pairs {
            self.still(ticket)?;
            let parse = limits
                .pair_parse
                .min(limits.reload_parse.saturating_sub(started.elapsed()));
            match load_pair(pair, parse, pair_limit.min(pairs_left)) {
                Ok((dictionary, time)) => {
                    pairs_left = pairs_left.saturating_sub(time);
                    pairs.push(dictionary);
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
        let engine = Arc::new(Engine {
            terms,
            pairs,
            pairs_off: AtomicBool::new(false),
        });
        let mut slot = self.engine.lock();
        self.still(ticket)?;
        let previous = std::mem::replace(&mut *slot, engine);
        drop(slot);
        // As camadas anteriores (dezenas de MiB) saem fora da trava.
        drop(previous);
        Ok(reloaded)
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

fn timeout(deadline: Duration) -> AppError {
    AppError::new("TIMEOUT").with_detail(serde_json::json!({ "seconds": deadline.as_secs() }))
}

/// Junta `batch` (esvaziado) a `found`, sem repetidas, na ordem.
fn merge(found: &mut Vec<String>, batch: &mut Vec<String>) {
    for suggestion in batch.drain(..) {
        if !found.contains(&suggestion) {
            found.push(suggestion);
        }
    }
}

/// O dicionário dos termos `.txt` das camadas (D-R34-5): `SET UTF-8` + o `TRY` da base (as letras
/// das sugestões por edição) e uma palavra por linha, sem flags (`/` vira `\/`, o separador delas).
/// A palavra em minúsculas vale também em Título e MAIÚSCULAS, como no Hunspell; e, num dicionário
/// à parte, vence o `FORBIDDENWORD` da base. Sem termos → `None`.
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

/// Carrega um par não confiável (D-R34-4): confere o `.dic` e o `.aff`, roda com `BREAK 0` (o
/// `BREAK` dele é ignorado), faz o parse com prazo e passa no teste de velocidade com `slow`.
/// Devolve o dicionário e o tempo do teste.
fn load_pair(
    pair: EnginePair,
    parse: Duration,
    slow: Duration,
) -> Result<(Dictionary, Duration), Refusal> {
    let dic = prepare_dic(&pair.dic)?;
    drop(pair.dic);
    vet_aff(&pair.aff)?;
    let mut aff = pair.aff;
    aff.push_str("\nBREAK 0\n");
    let dictionary = parse_within(aff, dic, parse)?;
    let time = timed(&dictionary, slow).ok_or(Refusal::Slow)?;
    Ok((dictionary, time))
}

/// O `.dic` de um par pronto para o parse: até 1.000.000 de linhas de até 4 KiB, e a contagem da
/// 1ª linha (com que o spellbook reserva até 2^20 entradas, ~33 MiB) trocada pelo número de linhas
/// que existem. Sem contagem válida → `Parse` (o spellbook também recusaria).
fn prepare_dic(dic: &str) -> Result<String, Refusal> {
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
    Ok(format!("{}\n{rest}", declared.min(lines)))
}

/// Diretivas que o `.aff` de um par não pode ter (D-R34-4): compostos (um `.aff` de 39 B com
/// `COMPOUNDFLAG` e `COMPOUNDMIN 2` levou 12,9 ms numa palavra de 33 letras, 1,4× a mais por letra),
/// circunfixo, prefixos complexos e alias de flags (`AF`: cada alias é copiado para cada linha do
/// `.dic` que o usa).
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
    /// Uma linha da tabela `key`, depois da diretiva.
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
        if key == "PFX" || key == "SFX" {
            // `<flag> <tira> <põe>[/<flags>] [condição]`
            let continuation = words
                .nth(2)
                .and_then(|add| add.split_once('/'))
                .is_some_and(|(_, flags)| !flags.is_empty());
            if continuation {
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
        Ok(())
    }
}

/// Confere o `.aff` de um par antes do parse (D-R34-4), lendo como o parser do spellbook: o BOM
/// inicial sai, linha começada por `#` é comentário, a 1ª palavra é a diretiva e uma tabela é o
/// cabeçalho com a contagem seguido dessas linhas. Linha acima de 4 KiB → `Lines`; diretiva
/// recusada → `Directive`; regras demais ou condição longa → `Rules`; tabela interrompida ou
/// contagem malformada → `Parse` (o parse também recusaria).
fn vet_aff(aff: &str) -> Result<(), Refusal> {
    let body = aff.strip_prefix('\u{FEFF}').unwrap_or(aff);
    let mut counts = AffCounts::default();
    let mut table: Option<(&str, usize)> = None;
    for line in body.lines() {
        if line.len() > LINE_MAX_BYTES {
            return Err(Refusal::Lines);
        }
        if line.trim_start().starts_with('#') {
            continue;
        }
        let mut words = line.split_whitespace();
        let key = words.next();
        if let Some((name, left)) = table.as_mut() {
            if key != Some(*name) {
                return Err(Refusal::Parse);
            }
            counts.row(name, words)?;
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
        let rows = match key {
            "PFX" | "SFX" => words.nth(2),
            "REP" | "ICONV" | "OCONV" | "MAP" | "BREAK" => words.next(),
            _ => continue,
        };
        let rows: usize = rows
            .and_then(|rows| rows.parse().ok())
            .ok_or(Refusal::Parse)?;
        if rows > 0 {
            table = Some((key, rows));
        }
    }
    match table {
        Some(_) => Err(Refusal::Parse),
        None => Ok(()),
    }
}

/// O parse de um par numa thread própria, com prazo: o spellbook não é interrompível, então,
/// estourado o prazo, a thread termina sozinha (os tetos limitam o trabalho) e o resultado é
/// descartado. Pânico no parse → `Parse`.
fn parse_within(aff: String, dic: String, limit: Duration) -> Result<Dictionary, Refusal> {
    let started = Instant::now();
    let (sender, receiver) = sync_channel(1);
    std::thread::Builder::new()
        .name("spell-pair".into())
        .spawn(move || {
            let _ = sender.send(Dictionary::new(&aff, &dic));
        })
        .map_err(|_| Refusal::Parse)?;
    match receiver.recv_timeout(limit) {
        Ok(_) if started.elapsed() >= limit => Err(Refusal::Timeout),
        Ok(Ok(dictionary)) => Ok(dictionary),
        Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => Err(Refusal::Parse),
        Err(RecvTimeoutError::Timeout) => Err(Refusal::Timeout),
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

/// O tempo do dicionário nas palavras do teste de velocidade; passou de `limit` → `None`, na hora.
fn timed(dictionary: &Dictionary, limit: Duration) -> Option<Duration> {
    let started = Instant::now();
    for word in CALIBRATION_WORDS.iter() {
        black_box(dictionary.check(word));
        if started.elapsed() > limit {
            return None;
        }
    }
    Some(started.elapsed())
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

/// Até 5 sugestões para `word` em `lang` (só `pt-BR`). Uma por vez; o pedido mais novo vence.
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

    /// Termo que o pt_BR do VERO não tem (o "colecistectomia" do desenho ele já tem).
    const TERM: &str = "colangiopancreatografia";
    /// Termo inventado das listas e dos pares de prova.
    const PAIR_TERM: &str = "zubênico";
    /// Par mínimo com o plural por `SFX` (UTF-8).
    const PLURAL_AFF: &[u8] = b"SET UTF-8\nSFX S Y 1\nSFX S 0 s .\n";
    const PLURAL_DIC: &str = "1\nzubênico/S\n";

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

    /// D-R34-4: passou do prazo → `TIMEOUT { seconds }` e os pares desligados (os termos `.txt`
    /// seguem valendo) até a próxima recarga.
    #[test]
    fn spell_deadline_times_out_and_turns_the_pairs_off_until_reload() {
        let world = World::new();
        world.global_file("zub.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/zub.aff", PLURAL_AFF);
        world.global_file("hunspell/zub.dic", PLURAL_DIC.as_bytes());
        let done = world.reload(false);
        assert_eq!((done.words, done.pairs, done.skipped), (1, 1, 0));
        assert!(unknown(&world.spell, &["zubênicos"]).is_empty());
        let generation = world.spell.next_check();
        let error = world
            .spell
            .check(generation, &owned(&["zubênicos"]), Duration::ZERO)
            .unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert_eq!(error.detail, Some(serde_json::json!({ "seconds": 0 })));
        assert_eq!(unknown(&world.spell, &["zubênicos", PAIR_TERM]), [0]);
        world.reload(false);
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

    /// D-R34-7: um termo do usuário entra nas sugestões antes do n-grama da base; os pares
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

    /// AC-R34-3: 50.000 SFX vazios cabem nas contagens, mas reprovam no teste de velocidade.
    #[test]
    fn spell_ac3_a_slow_pair_fails_the_speed_test() {
        let world = World::new();
        let aff = String::from("SET UTF-8\nSFX A Y 50000\n") + &"SFX A 0 0 .\n".repeat(50_000);
        assert_eq!(vet_aff(&aff), Ok(()));
        world.global_file("lenta.txt", PAIR_TERM.as_bytes());
        world.global_file("hunspell/lenta.aff", aff.as_bytes());
        world.global_file("hunspell/lenta.dic", "1\nzubênico/A\n".as_bytes());
        let done = world.reload(false);
        assert_eq!((done.pairs, done.skipped, done.refused.slow), (0, 1, 1));
    }

    /// AC-R34-3: o parse que passa do prazo (por par ou o da recarga) deixa o par de fora.
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
        assert_eq!(world.reload(false).pairs, 1);
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
    /// linha, diretivas recusadas (também depois do BOM) e tabela malformada — no limite passa,
    /// um acima reprova. O pt_BR embutido passa.
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
        ] {
            assert_eq!(vet_aff(&ok), Ok(()));
            assert_eq!(vet_aff(&over), Err(Refusal::Rules));
        }
        assert_eq!(vet_aff(&format!("TRY {}\n", "a".repeat(4_092))), Ok(()));
        assert_eq!(
            vet_aff(&format!("TRY {}\n", "a".repeat(4_093))),
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
            assert_eq!(vet_aff(directive), Err(Refusal::Directive), "{directive}");
        }
        assert_eq!(vet_aff("# COMPOUNDFLAG A\n"), Ok(()));
        for broken in [
            "PFX A Y 2\nPFX A 0 x .\n",
            "REP x\n",
            "SFX A Y 1\n\nSFX A 0 s .\n",
        ] {
            assert_eq!(vet_aff(broken), Err(Refusal::Parse), "{broken}");
        }
        assert_eq!(vet_aff(BASE_AFF), Ok(()));
    }

    /// AC-R34-3: o `.dic` de um par — até 1.000.000 de linhas de até 4 KiB; a contagem declarada
    /// (a reserva de memória do spellbook) vira a real; sem contagem → recusado. O pt_BR passa.
    #[test]
    fn spell_ac3_dic_caps_and_the_declared_count() {
        assert_eq!(prepare_dic("2\nzub\nzux\n").as_deref(), Ok("2\nzub\nzux\n"));
        assert_eq!(
            prepare_dic("# c\n999999999\nzub\n").as_deref(),
            Ok("3\nzub\n")
        );
        assert_eq!(prepare_dic("zub\n"), Err(Refusal::Parse));
        assert_eq!(prepare_dic(""), Err(Refusal::Parse));
        assert!(prepare_dic(&format!("1\n{}\n", "z".repeat(4_096))).is_ok());
        assert_eq!(
            prepare_dic(&format!("1\n{}\n", "z".repeat(4_097))),
            Err(Refusal::Lines)
        );
        assert!(prepare_dic(&format!("1\n{}", "z\n".repeat(999_999))).is_ok());
        assert_eq!(
            prepare_dic(&format!("1\n{}", "z\n".repeat(1_000_000))),
            Err(Refusal::Lines)
        );
        assert!(prepare_dic(BASE_DIC).is_ok());
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
