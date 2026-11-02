# Mon espace — Dashboard personnel

Un dashboard personnel statique, en français et adapté aux ordinateurs et téléphones.

Il regroupe les tâches et leurs échéances, les projets et leur progression, les habitudes quotidiennes, les notes, les raccourcis et un minuteur de concentration.

## Données personnelles

Le contenu est sauvegardé uniquement dans le navigateur utilisé (localStorage). Aucune donnée personnelle n’est envoyée à GitHub et il n’y a pas de synchronisation entre appareils. Le menu « Personnaliser » permet d’exporter ou d’importer une copie JSON. Un changement d’adresse du site utilise un espace de sauvegarde distinct : exportez vos données avant de les transférer sur la nouvelle adresse.

Les tâches et habitudes initiales sont des suggestions à personnaliser.

## Publication avec GitHub Pages

Les fichiers du site sont à la racine du dépôt. Dans **Settings → Pages**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Aucun build ni dépendance n’est nécessaire.

Le fichier `.nojekyll` conserve la publication des fichiers statiques sans traitement Jekyll. Les chemins des ressources sont relatifs et compatibles avec une adresse de projet comme `/dashboard-personnel/`.
