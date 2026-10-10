//! Erro serializado para o webview (arch-backend r2 §1.10): `{ code, message, detail? }`. A
//! mensagem é fixa por código, em pt-BR, e nunca carrega caminhos absolutos nem conteúdo de arquivo.

use std::io;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: &'static str) -> Self {
        let message = match code {
            "NOT_FOUND" => "Arquivo ou pasta não encontrado.",
            "ALREADY_EXISTS" => "O arquivo já existe.",
            "PERMISSION_DENIED" => "Acesso negado.",
            "INVALID_PATH" => "Caminho inválido.",
            "OUTSIDE_VAULT" => "Caminho fora da pasta aberta.",
            "TOO_LARGE" => "Arquivo grande demais.",
            "NO_VAULT" => "Nenhuma pasta aberta.",
            "VAULT_CLOSED" => "A pasta foi fechada.",
            "SAME_AS_SOURCE" => "O destino é o próprio arquivo de origem.",
            "TOKEN_INVALID" => "Destino de gravação inválido ou expirado.",
            "INVALID_ID" => "Id de plugin inválido.",
            "INVALID_HASH" => "Hash de código inválido.",
            "NOT_APPROVED" => "O plugin não foi aprovado neste dispositivo.",
            "STORE_IO" => "Não foi possível gravar as aprovações de plugins.",
            // Chaves (r2 §1.7.3; STR-125). A mensagem nunca leva o valor da chave.
            "INVALID_PROVIDER" => "Provedor de IA inválido.",
            "INVALID_KEY_FORMAT" => "Chave em formato inválido. A chave não foi salva.",
            "KEYCHAIN_DENIED" => "Acesso ao keychain negado. A chave não foi salva.",
            "KEYCHAIN_UNAVAILABLE" => "Keychain do sistema indisponível. A chave não foi salva.",
            // Transporte de IA (r2 §1.7.2; STR-129). O TS remapeia por código e provedor.
            "HOST_NOT_ALLOWED" => "Endereço não permitido.",
            "PATH_NOT_ALLOWED" => "Caminho não permitido para este provedor.",
            "HEADER_NOT_ALLOWED" => "Cabeçalho não permitido.",
            "BODY_TOO_LARGE" => "Pedido grande demais.",
            "LOCAL_LIMIT" => "Muitas solicitações ao mesmo tempo; aguarde uma terminar.",
            "KEY_MISSING" => "Sem chave para este provedor. Salve uma em Configurações → IA.",
            "CONNECTION_REFUSED" => "Conexão recusada.",
            "TLS" => "Falha na conexão segura.",
            "NETWORK" => "Sem conexão com o provedor.",
            "TIMEOUT_FIRST_BYTE" => "O provedor não respondeu a tempo.",
            "TIMEOUT_IDLE" => "A resposta parou de chegar.",
            "REDIRECT_NOT_FOLLOWED" => {
                "O provedor redirecionou para outro endereço; a resposta foi recusada."
            }
            // Abrir URL no navegador/cliente de e-mail (r7 §1.2, R-X7.6). Nunca a URL na mensagem.
            "URL_INVALID" => "Endereço inválido.",
            "URL_SCHEME_NOT_ALLOWED" => "Tipo de link não suportado.",
            "URL_CREDENTIALS" => "Links com usuário ou senha não são abertos.",
            "URL_CONTROL_CHAR" => "O link tem caracteres de controle.",
            "URL_TOO_LONG" => "Link longo demais.",
            "URL_MAILTO_PARAM" => "Link de e-mail com parâmetro não permitido.",
            "RATE_LIMITED" => "Muitos links abertos em sequência; aguarde alguns segundos.",
            "OPEN_FAILED" => "Não foi possível abrir o navegador ou o cliente de e-mail.",
            // Imagens do vault (r7 §1.3, R-I1.7).
            "UNSUPPORTED_IMAGE" => "Tipo de imagem não suportado.",
            // LanguageTool local (r7 §1.4, R-I8.2). O plugin mapeia por código.
            "LT_INVALID_REQUEST" => "Pedido de verificação inválido.",
            "LT_HTTP_STATUS" => "O LanguageTool respondeu com erro.",
            "TIMEOUT" => "O servidor não respondeu a tempo.",
            "RESPONSE_TOO_LARGE" => "Resposta grande demais.",
            "BAD_UTF8" => "A resposta chegou incompleta.",
            "CANCELLED" => "Pedido cancelado.",
            _ => "Falha de E/S.",
        };
        Self {
            code,
            message,
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// Classifica pelo `io::ErrorKind` (nunca pelo texto do SO). Violação de compartilhamento do
    /// Windows e o resto caem em `IO`.
    pub fn io(error: &io::Error) -> Self {
        Self::new(match error.kind() {
            io::ErrorKind::NotFound => "NOT_FOUND",
            io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            io::ErrorKind::NotADirectory => "INVALID_PATH",
            _ => "IO",
        })
    }
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self::io(&error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_kinds_map_to_codes() {
        let table = [
            (io::ErrorKind::NotFound, "NOT_FOUND"),
            (io::ErrorKind::AlreadyExists, "ALREADY_EXISTS"),
            (io::ErrorKind::PermissionDenied, "PERMISSION_DENIED"),
            (io::ErrorKind::NotADirectory, "INVALID_PATH"),
            (io::ErrorKind::StorageFull, "IO"),
            (io::ErrorKind::Other, "IO"),
        ];
        for (kind, code) in table {
            assert_eq!(AppError::io(&io::Error::from(kind)).code, code, "{kind:?}");
        }
    }

    /// r7 §1.10: cada código novo tem mensagem própria (nunca o "Falha de E/S." do padrão).
    #[test]
    fn r7_codes_have_their_own_message() {
        let fallback = AppError::new("IO").message;
        for code in [
            "URL_INVALID",
            "URL_SCHEME_NOT_ALLOWED",
            "URL_CREDENTIALS",
            "URL_CONTROL_CHAR",
            "URL_TOO_LONG",
            "URL_MAILTO_PARAM",
            "RATE_LIMITED",
            "OPEN_FAILED",
            "UNSUPPORTED_IMAGE",
            "LT_INVALID_REQUEST",
            "LT_HTTP_STATUS",
            "TIMEOUT",
        ] {
            assert_ne!(AppError::new(code).message, fallback, "{code}");
        }
    }

    #[test]
    fn serializes_code_message_and_optional_detail() {
        let plain = serde_json::to_value(AppError::new("NO_VAULT")).unwrap();
        assert_eq!(
            plain,
            serde_json::json!({ "code": "NO_VAULT", "message": "Nenhuma pasta aberta." })
        );
        let detailed = AppError::new("TOO_LARGE").with_detail(serde_json::json!({ "size": 9 }));
        assert_eq!(
            serde_json::to_value(detailed).unwrap()["detail"],
            serde_json::json!({ "size": 9 })
        );
    }
}
