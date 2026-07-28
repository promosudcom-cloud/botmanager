# Bot Manager (V2)

Bot qui gère des **codes de licence** et démarre les bots des clients (type
**Music** ou **IA**), chacun avec son propre token, dans un processus
séparé, pour une durée limitée.

## Fonctionnement général

1. Un admin (rôle autorisé) crée une licence avec `/cree-licence` → reçoit un
   **code** (ex. `A1B2C3D4`), à transmettre au client (en DM, par exemple).
2. Le client active son bot avec `/active-bot token:<son token> licence-id:<le code>`.
3. Il le démarre avec `/mybot action:start`.

## ⚠️ Sécurité — à lire avant de déployer

- `data/licenses.json` contient des **tokens Discord d'autres personnes** en
  clair. Ne le mets jamais sur un dépôt public, restreins l'accès au dossier.
- `/active-bot` prend le token en paramètre de commande. Comme la réponse est
  **ephemeral**, Discord cache aussi la ligne d'invocation aux autres membres
  du salon (seul l'auteur de la commande voit ce qu'il a tapé) — donc pas de
  fuite publique. Mais garde `data/licenses.json` sensible pour autant.
- Le bot IA utilise une **clé OpenRouter partagée** (`OPENROUTER_API_KEY`
  dans le `.env` du Manager) : c'est ton compte qui paie les requêtes de tous
  les bots IA clients. Le client ne fournit que son propre token Discord.

## 1. Créer l'application Discord du Manager

1. https://discord.com/developers/applications → nouvelle application.
2. Onglet **Bot** → crée le bot, copie le token (`MANAGER_TOKEN`).
3. Onglet **General Information** → copie l'**Application ID** (`CLIENT_ID`).
4. Onglet **OAuth2 → URL Generator** : scope `bot` + `applications.commands`,
   permissions `Send Messages`, `Use Slash Commands`. Invite le bot.
5. Récupère l'ID de ton serveur (`GUILD_ID`) : mode développeur activé
   (Paramètres → Avancés) → clic droit sur le serveur → Copier l'identifiant.
6. Récupère les IDs des rôles autorisés à gérer les licences
   (`ALLOWED_ROLE_IDS`), séparés par des virgules.
7. Récupère ta clé API sur https://openrouter.ai (`OPENROUTER_API_KEY`).

## 2. Installer

```bash
npm install
cp .env.example .env
```

Remplis `.env` avec les valeurs récupérées ci-dessus.

## 3. Déployer les commandes slash

```bash
npm run deploy
```

À refaire à chaque fois que tu modifies `deploy-commands.js`.

## 4. Lancer le Manager

```bash
npm start
```

## Commandes

### Admin (rôle autorisé uniquement)

- `/cree-licence type:music|ia jours:30` — crée un code de licence.
- `/supprime-licence licence-id:A1B2C3D4` — supprime la licence, coupe le bot lié.
- `/prolonge-licence licence-id:A1B2C3D4 jours:15` — ajoute des jours.
- `/liste-licences` — liste toutes les licences, à qui elles sont liées, et leur statut.

### Client

- `/active-bot token:<son token> licence-id:<le code>` — active son bot.
- `/mybot action:start` — démarre son bot.
- `/mybot action:stop` — arrête son bot.
- `/mybot action:status` — voit le statut, le type et la date d'expiration.

## Comment ça marche

- Chaque bot client tourne dans un **processus Node séparé**
  (`templates/music-bot.js` ou `templates/ia-bot.js`), lancé avec son propre
  token via `fork()`. `/mybot stop` (ou l'expiration de la licence) l'arrête
  proprement.
- Une vérification toutes les 10 minutes coupe automatiquement les bots dont
  la licence a expiré.
- `templates/music-bot.js` reprend exactement le bot du dossier `BOT MUSIC`
  (`+play`, `+add`, `+jouer`, `+queue`, `+pause`, `+stop`, etc.).
- `templates/ia-bot.js` reprend ton bot IA : répond quand on le mentionne,
  via OpenRouter (modèle `nvidia/nemotron-3-ultra-550b-a55b:free`), avec le
  prompt système dans `templates/prompts/system.txt` (modifiable).
