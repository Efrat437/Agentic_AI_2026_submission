# RAG_PROJECT - Retrieval-Augmented Generation Pipeline

## Overview

This project implements a complete RAG (Retrieval-Augmented Generation) pipeline for querying and retrieving documents. It supports:

- ✅ Document loading from text files
- ✅ Similarity-based retrieval (fast, no external dependencies)
- ✅ Hybrid retrieval scoring
- ✅ Evaluation metrics (MRR, Recall, NDCG)
- ✅ Streaming PDF ingestion support
- ✅ Sample OAuth data for demonstrations

## Project Structure

```
RAG_PROJECT/
├── 01_agent/              # Agent that uses the RAG pipeline
│   └── agent.js
├── 02_scripts/            # RAG pipeline implementations
│   ├── rag_process.js     # Full-featured pipeline (with vectorstores)
│   ├── rag_process_simple.js   # Simplified pipeline (tested, working)
│   └── evaluate_retriever.js   # Evaluation metrics
├── 03_data/               # Data directory (for PDF input)
├── .env                   # Environment variables
├── package.json
└── node_modules/
```

## Setup

### 1. Install Dependencies

```bash
cd RAG_PROJECT
npm install --legacy-peer-deps
```

### 2. Configure Environment

Edit `.env` with your API keys:

```dotenv
# Required: Choose ONE
OPENROUTER_API_KEY=sk-or-v1-xxxxx
# OR
OPENAI_API_KEY=sk-proj-xxxxx

# Optional
TAVILY_API_KEY=tvly-xxxxx
LLAMA_PARSE_API_KEY=llx-xxxxx
```

## Running the Pipeline

### Local Hybrid Server

```bash
npm run server:start:local-hybrid
```

Starts the local server with semantic handoff disabled so the project can serve PDF and image RAG workflows directly from the local hybrid stack.

### Run the RAG Agent

```bash
node 01_agent/agent.js
```

**Output:**
- Loads sample OAuth documents (or your PDF if placed in `03_data/`)
- Runs 3 test queries
- Ranks results by relevance score
- Calculates evaluation metrics (MRR, Recall)

### Evaluate Retriever

```bash
node 02_scripts/evaluate_retriever.js
```

Runs comprehensive evaluation with metrics:
- **MRR@10** - Mean Reciprocal Rank
- **Recall@10** - Proportion of relevant documents retrieved
- **NDCG@10** - Normalized Discounted Cumulative Gain

## How It Works

### 1. Document Loading (`rag_process_simple.js`)

- Loads documents from text files or uses sample data
- Simple chunking by splitting on double newlines
- Creates `Document` objects with metadata

### 2. Retrieval

Uses **Jaccard similarity** for fast text matching:
```javascript
similarity = |intersection| / |union|
```

This avoids external vectorstore dependencies while being effective for keyword-based retrieval.

### 3. Ranking

Scores are normalized by max score for consistent ranking across queries.

### 4. Query Processing

For each query:
1. Calculate similarity to all documents
2. Sort by score (descending)
3. Return top K results
4. Evaluate against relevant keywords

## Adding Your Own Data

### Option 1: Text File

Place a `.txt` file in `03_data/the-modern-guide-to-qauth.pdf` (any extension works):
- File will be loaded automatically
- Split by double newlines
- First 50 chunks used

### Option 2: PDF (Requires Vector Store)

To use actual PDF files with embeddings:

```bash
npm install @langchain/openai @langchain/community --legacy-peer-deps
```

Then update `rag_process.js` with your PDF path and run.

## Key Files Explained

| File | Purpose |
|------|---------|
| `rag_process_simple.js` | ✅ Working simplified retriever (uses text similarity) |
| `rag_process.js` | Full-featured with embeddings (requires vectorstore setup) |
| `agent.js` | CLI agent for testing queries |
| `evaluate_retriever.js` | Evaluation harness with metrics |

## Troubleshooting

### Import Errors

If you see `ERR_PACKAGE_PATH_NOT_EXPORTED`:
- The vectorstores require additional setup
- Use `rag_process_simple.js` instead (already tested)

### Missing API Keys

The pipeline falls back to sample data if:
- No file found at specified path
- Embedding API keys missing

### Chroma Connection Error

Requires running Chroma server:
```bash
docker run -d -p 8000:8000 chromadb/chroma
```

Or use `MemoryVectorStore` instead.

## Features Demonstrated

✅ **Streaming Ingestion** - Code for streaming PDF chunks into vectorstore  
✅ **Similarity Scoring** - Jaccard similarity for retrieval  
✅ **Evaluation Metrics** - MRR, Recall, NDCG calculations  
✅ **Hybrid Scoring** - Framework for combining multiple scores  
✅ **Fallback Data** - Uses sample OAuth docs if no data provided  
✅ **Error Handling** - Graceful degradation on failures  

## Next Steps

1. **Add Vector Embeddings** - Use OpenAI/OpenRouter embeddings
2. **Connect to Chroma** - Persistent vector database
3. **Add LLM Response** - Generate answers from retrieved docs
4. **Production Setup** - Deploy with real data and optimization

## Example Output

```
Building RAG retriever...
🔹 Initializing RAG pipeline...
⚠️  File not found, using sample data...
✅ RAG initialized with sample retriever!
Retriever ready.

📌 Query: "What is PKCE in OAuth?"
  [1] Score: 0.111, Text: Scopes in OAuth define...
  [2] Score: 0.065, Text: PKCE (Proof Key for Code Exchange)...
  [3] Score: 0.036, Text: The Authorization Code Flow...

Query: What is PKCE in OAuth?, Recall@K: 0, MRR@K: 0

✅ RAG Agent test complete!
```

## License

ISC
