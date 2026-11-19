# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Seez storefront

The storefront is available at `/seez.html`; the private order dashboard is at `/seez-admin.html`. The order form collects a name, phone number, delivery address, perfume, and volume. WhatsApp is for support, not order submission. Local development stores orders in the server's SQLite database; Cloudflare Pages stores them in D1.

Initialize the database and run both the client and API server from the repository root:

```sh
npm run db:migration:up
npm run dev
```

For local development, sign in to the order dashboard with the server's dashboard account. For a public Cloudflare Pages deployment:

1. Connect the repository at its root. Set the build command to `npm run build -w client` and the output directory to `client/dist`.
2. Set build variables `NODE_VERSION=24` and `VITE_SEEZ_CLOUDFLARE=1` for Production and Preview.
3. Create a D1 database, run `migrations/0001_seez_orders.sql` against it, then bind it to Pages Functions as `SEEZ_DB` for each environment.
4. Add `SEEZ_ADMIN_PASSWORD` as a secret in the Pages project settings. Use a unique password of at least 16 characters and do not commit it.

The public URL will be a Cloudflare `pages.dev` address; a custom domain is optional. Before connecting the Git repository, push these changes to GitHub. Protect the D1 database and customer data; the admin API only returns orders to a password-authenticated session.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
