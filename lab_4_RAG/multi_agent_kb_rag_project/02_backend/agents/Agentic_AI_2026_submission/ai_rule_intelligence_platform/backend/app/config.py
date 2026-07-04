from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql://langchain:langchain@localhost:5432/langchain"
    embedding_server_url: str = "http://localhost:3005"
    embedding_model: str = "Xenova/all-MiniLM-L6-v2"
    embedding_dim: int = 384
    top_k: int = 30
    llm_top_n: int = 5
    similarity_threshold: float = 0.5
    union_similarity_threshold: float = 0.9
    embedding_retries: int = 3
    embedding_retry_backoff_ms: int = 250
    cross_encoder_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    openai_api_key: str = ""
    llm_model: str = "gpt-4o-mini"


settings = Settings()
