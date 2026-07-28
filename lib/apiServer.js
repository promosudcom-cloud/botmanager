const express = require('express');
const licenses = require('./licenses');

// Petit serveur HTTP interne, séparé du bot Discord, utilisé UNIQUEMENT par
// le site web (fonctions Vercel) pour créer une vraie licence automatiquement
// juste après un paiement confirmé — l'équivalent de taper /cree-licence à la main,
// mais fait par le site directement.
//
// Protégé par un secret partagé (MANAGER_API_SECRET) : jamais accessible sans lui.
// Ce n'est PAS fait pour être exposé librement sur Internet sans ce secret.

function startApiServer() {
  const app = express();
  app.use(express.json());

  const PORT = process.env.MANAGER_API_PORT || 4000;
  const SECRET = process.env.MANAGER_API_SECRET;

  if (!SECRET) {
    console.warn('[manager-api] ⚠️ MANAGER_API_SECRET absent du .env — le serveur API interne ne démarre pas.');
    return;
  }

  app.post('/internal/create-license', (req, res) => {
    const auth = req.headers['x-manager-secret'];
    if (auth !== SECRET) {
      return res.status(401).json({ error: 'Secret invalide' });
    }

    const { type, days } = req.body || {};

    if (!['gestion', 'music', 'ia'].includes(type)) {
      return res.status(400).json({ error: "type invalide (attendu: 'gestion', 'music' ou 'ia')" });
    }
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ error: 'days doit être un entier positif' });
    }

    const license = licenses.create(type, days, 'site-paiement');

    res.status(200).json({
      id: license.id,
      type: license.type,
      expiresAt: license.expiresAt,
    });
  });

  app.listen(PORT, () => {
    console.log(`[manager-api] Serveur interne de création de licence prêt sur le port ${PORT}`);
  });
}

module.exports = { startApiServer };
