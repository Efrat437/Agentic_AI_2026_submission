-- Table for storing RAG document chunks and their embeddings
CREATE TABLE IF NOT EXISTS rag_documents (
    id SERIAL PRIMARY KEY,
    receipt_id INTEGER REFERENCES receipts(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL, -- Adjust dimension to match your embedding model
    chunk_index INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    meta JSONB
);

-- Index for fast vector search (pgvector)
CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding ON rag_documents USING ivfflat (embedding vector_cosine_ops);

-- Optional: Index for fast lookup by receipt
CREATE INDEX IF NOT EXISTS idx_rag_documents_receipt_id ON rag_documents(receipt_id);
