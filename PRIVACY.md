# Privacy Policy — n8n-nodes-dualtran

The DualTran node translates the text you pass to it. It collects **nothing**:
no analytics, no telemetry, no accounts, no developer server.

- Text is sent only to the translation service **you** selected: Google
  (default, free, no account) or, with the AI engine, directly to your AI
  provider using the API key stored in the n8n credential.
- Credentials (including the API key) live in your n8n instance, encrypted
  with your n8n encryption key like any other n8n credential.
- No other network requests are made.

Bundled engine: `@dualtran/core` (MPL-2.0), extracted from
https://github.com/seigwen/DualTran-extension.

Contact: seigwen — seigwen@gmail.com — https://github.com/seigwen/DualTran-extension/issues
