# Design Role Questioner (MVP)

## Quick start
1. Copy `.env.example` to `.env` and add your OpenAI key.
2. Run `npm run dev`.
3. Open `http://localhost:3000`.

## Notes
- The server fetches the public job page and extracts readable text.
- Some sites (especially LinkedIn) may block automated fetching.
- If the URL fails, paste the job text in the UI and submit.
