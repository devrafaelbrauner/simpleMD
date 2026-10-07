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
