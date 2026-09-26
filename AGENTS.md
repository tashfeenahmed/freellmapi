# AGENTS.md — freellmapi

Kurzfassung der Fakten fuer jeden Agenten, der in diesem Projekt arbeitet.
Aus `package.json`, `CONTRIBUTING.md` und der Ordnerstruktur abgeleitet (26.09.2026).

## Was das ist

npm-Monorepo mit Workspaces: `shared`, `server`, `client`, `cli`.
Dazu ein `desktop`-App-Teil (Electron) und `docker-compose.yml`.

## Voraussetzungen

- Node `>=20.18.0 <25.0.0`
- npm `>=10`
- `.nvmrc` liegt im Repo — bei Node-Wechsel `nvm use` nicht vergessen.

## Befehle

| Zweck | Befehl |
|---|---|
| Entwicklung (Server + Client) | `npm run dev` |
| Entwicklung im LAN (für Handy-Tests) | `npm run dev:lan` |
| **Tests** | `npm test` |
| Tests der Bootstrap-Logik | `npm run test:bootstrap` |
| Tests der Contributing-Hooks | `npm run test:hooks` |
| Lint | `npm run lint` |
| Build | `npm run build` |
| Migration anlegen | `npm run db:migration:create` |
| Migration ausführen | `npm run db:migration:up` |
| Migrationsstatus | `npm run db:migration:status` |
| Datenbank neu aufsetzen (**löscht Daten**) | `npm run db:migration:fresh` |
| Desktop-App | `npm run desktop:dev` / `npm run desktop:dist` |

`npm test` ist der Befehl, der vor jedem Abschluss einer Änderung laufen muss.
Er deckt Bootstrap, Hooks, Server, CLI und Client ab.

## Regeln für Agenten

1. **`.env` wird nicht gelesen.** Im Repo liegt `.env` mit `ENCRYPTION_KEY` und
   Server-Konfiguration. Nutze `.env.example` als Vorlage und nenne nur
   Variablennamen. Hausregel: `C:\Users\pasca\.agents\SECRETS-POLICY.md`.
2. `npm run db:migration:fresh` ist destruktiv. Nie ungefragt ausführen.
3. Neue Migrationen über `db:migration:create` erzeugen, Dateiname nicht von Hand
   vergeben — das Skript vergibt die Reihenfolge.
4. Workspaces getrennt ansprechen: `npm run <script> -w server` usw.
   Keine `cd`-Ketten im Repo.
5. Es gibt einen Git-Hook `contributing-check.mjs` (`.claude/hooks/`). Er läuft in
   `npm test` mit — wenn er fehlschlägt, erst `CONTRIBUTING.md` lesen.
