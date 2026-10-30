// Configuration de Tabi. Rien ici n'est secret : l'ID client OAuth et l'ID de dossier
// sont publics par nature ; l'accès aux données reste protégé par les comptes Google.
export const CONFIG = {
  // ID client OAuth « Application Web » créé dans Google Cloud Console (projet Tabi).
  clientId: '893519171813-v1pocjj1q8jk9jaha2nhln62916nam0b.apps.googleusercontent.com',
  // Dossier Drive « Tabi - Japon » (contient data/, photos/, billets/).
  rootFolderId: '1PNvIMPKu0ciOo_QkDu8FmYB0UQ_MKcvG',
  // Fond de carte vectoriel gratuit, sans clé (OpenFreeMap, données OpenStreetMap).
  mapStyle: 'https://tiles.openfreemap.org/styles/liberty',
  // Accès Drive complet : nécessaire pour voir les fichiers créés par l'autre personne.
  scope: 'https://www.googleapis.com/auth/drive',
  syncEveryMs: 45000,
};
