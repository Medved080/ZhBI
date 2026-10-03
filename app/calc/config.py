import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    environment: str = "development"
    auth_required: bool = True
    secure_cookies: bool = False
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "testserver")
    max_upload_mb: int = 50
    max_body_mb: int = 100
    session_hours: int = 8
    recovery_worker_enabled: bool = True
    qwen_api_key: str = ""
    qwen_allowed_hosts: tuple[str, ...] = ()
    recovery_assets_dir: Path | None = None

    @classmethod
    def embedded(cls):
        """Настройки подсистемы внутри ЖБИ: вход, хосты и лимиты тела запроса
        обслуживает сам сервис ЖБИ, поэтому здесь важны только каталоги, лимит
        файла вложения и фоновый разбор чертежей (на серверах он выключен:
        нужен локальный GPU, включается ZHBI_CALC_RECOVERY_WORKER=1)."""
        from .paths import CALC_DIR
        on = os.getenv("ZHBI_CALC_RECOVERY_WORKER", "0").lower() in {"1", "true", "yes"}
        return cls(
            data_dir=CALC_DIR,
            environment="development",
            auth_required=True,
            max_upload_mb=int(os.getenv("ZHBI_CALC_MAX_UPLOAD_MB", "50")),
            max_body_mb=int(os.getenv("ZHBI_MAX_UPLOAD_MB", "200")),
            recovery_worker_enabled=on,
            qwen_api_key=os.getenv("CALCZHB_QWEN_API_KEY", ""),
            qwen_allowed_hosts=tuple(h.strip().lower() for h in os.getenv("CALCZHB_QWEN_ALLOWED_HOSTS", "").split(",") if h.strip()),
        )

    @classmethod
    def from_env(cls):
        flag = lambda name, default: os.getenv(name, default).lower() in {"1", "true", "yes"}
        settings = cls(
            data_dir=Path(os.getenv("CALCZHB_DATA_DIR", str(ROOT / "data"))).resolve(),
            environment=os.getenv("CALCZHB_ENV", "development"),
            auth_required=flag("CALCZHB_AUTH_REQUIRED", "1"),
            secure_cookies=flag("CALCZHB_SECURE_COOKIES", "0"),
            allowed_hosts=tuple(h.strip() for h in os.getenv("CALCZHB_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()),
            max_upload_mb=int(os.getenv("CALCZHB_MAX_UPLOAD_MB", "50")),
            max_body_mb=int(os.getenv("CALCZHB_MAX_BODY_MB", "100")),
            recovery_worker_enabled=flag("CALCZHB_RECOVERY_WORKER", "1"),
            qwen_api_key=os.getenv("CALCZHB_QWEN_API_KEY", ""),
            qwen_allowed_hosts=tuple(h.strip().lower() for h in os.getenv("CALCZHB_QWEN_ALLOWED_HOSTS", "").split(",") if h.strip()),
        )
        settings.validate()
        return settings

    def validate(self):
        if self.environment not in {"development", "test", "production"}:
            raise ValueError("CALCZHB_ENV must be development, test or production")
        if self.environment == "production" and (not self.auth_required or not self.secure_cookies):
            raise ValueError("Production requires authentication and secure HTTPS cookies")
        if not self.allowed_hosts or "*" in self.allowed_hosts:
            raise ValueError("Explicit CALCZHB_ALLOWED_HOSTS are required")
        if not 1 <= self.max_upload_mb <= self.max_body_mb <= 1000:
            raise ValueError("Invalid upload limits")
        if '\n' in self.qwen_api_key or '\r' in self.qwen_api_key:
            raise ValueError('Invalid CALCZHB_QWEN_API_KEY header value')

    @property
    def database_path(self):
        return self.data_dir / "calczhbi.sqlite3"
