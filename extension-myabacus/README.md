# Dashboard · MyAbacus local (Edge)

Extension personnelle Manifest V3, version **1.1.0**. Pendant que le dashboard est ouvert et connecté, elle ouvre une page MyAbacus temporaire en arrière-plan environ toutes les **10 minutes**, consulte la vue personnelle In & Out puis referme uniquement l’onglet qu’elle a créé. Aucun accès Q910/Q981 ni API Abacus n’est nécessaire.

## Installation

1. Dans Edge, ouvrir **Extensions → Gérer les extensions** (`edge://extensions`).
2. Activer **Mode développeur**, puis **Charger l’extension non empaquetée**.
3. Choisir ce dossier `extension-myabacus`, contenant `manifest.json` (décompresser l’archive d’abord si nécessaire).
4. Recharger le [dashboard](https://soaresbm1.github.io/dashboard-personnel/) et se connecter avec son compte Microsoft propriétaire habituel.
5. Dans le **même profil Edge**, ouvrir [MyAbacus](https://abaprod.isp-spi.ch/portal/myabacus/) et se connecter directement au portail. L’interface doit être en français. L’onglet peut ensuite être fermé.
6. Le dashboard consulte l’état local toutes les 20 secondes. Une lecture démarre à l’ouverture puis lorsque 10 minutes se sont écoulées depuis la dernière tentative. Les requêtes répétées et plusieurs dashboards ne créent pas plusieurs onglets simultanés.
7. Dans « Connexion locale », **Actualiser maintenant** lance une lecture anticipée, avec un intervalle minimal de 30 secondes entre tentatives. Si la session expire, se reconnecter manuellement dans MyAbacus puis utiliser ce bouton.

Une éventuelle politique d’entreprise interdisant les extensions non empaquetées doit être respectée ; l’extension ne modifie aucune politique Edge.

## Données et limites

- Solde d’heures **total**, en heures décimales signées.
- Vacances restantes **à ce jour**, en jours.
- Vacances disponibles **après la planification au 31 décembre**, en jours ; cette valeur reste distincte du solde courant.
- Date affichée par MyAbacus et date de lecture locale.

La date « Lu à » correspond à l’acquisition de valeurs stables dans la nouvelle page temporaire. Une simple consultation du cache ne rajeunit pas cette date. Les compteurs restent consultables pendant **15 minutes au maximum**, jusqu’au prochain changement de jour en Suisse, ou jusqu’à la déconnexion Microsoft. Une panne conserve uniquement un relevé encore valide avec une indication de lecture ancienne ; une valeur manquante n’est jamais remplacée par zéro. La nouvelle page demande les informations au portail, mais l’extension ne reconstitue pas les soldes et ne garantit pas le calendrier de calcul du serveur Abacus.

Edge doit rester ouvert. Aucun nouveau passage n’est lancé lorsque le dashboard est fermé. Une lecture déjà commencée peut finir, avec un délai limite de **60 secondes**. La veille du PC et la suspension des onglets peuvent retarder les passages ; le retour au dashboard rattrape une tentative échue. Les alarmes ne servent qu’au nettoyage, jamais à lire MyAbacus lorsque le dashboard est fermé.

La lecture s’arrête si la date n’est pas aujourd’hui en Suisse, si le compte affiché n’est pas celui attendu, si la page ne correspond pas au lien personnel In & Out de sa navigation, si un autre sélecteur est présent ou si les libellés sont ambigus. Un changement de présentation/langue de MyAbacus peut nécessiter une adaptation. Une valeur absente n’est jamais remplacée par zéro.

## Confidentialité et lecture seule

Les permissions explicites sont `storage` et `alarms` (nettoyage après délai ou interruption du worker). Les scripts sont limités aux pages d’accueil/In & Out de cette installation et au chemin exact du dashboard. Pas de permission générale `tabs`, de `cookies`, `webRequest`, `debugger`, API de saisie, appel HTTP direct, mot de passe, jeton ni lecture d’un magasin interne de MyAbacus. Seules les navigations normales du nouvel onglet chargent le portail. Les champs de pointage et boutons de saisie ne sont jamais manipulés.

L’onglet temporaire suit uniquement le lien personnel In & Out du menu du compte attendu. Si l’utilisateur sélectionne cet onglet ou interagit avec lui, l’automatisme en abandonne la fermeture et la navigation. Les onglets préexistants ne sont ni parcourus, ni rechargés, ni fermés. Une fermeture automatique exige l’identifiant de l’onglet créé, son appartenance au traitement courant et son état inactif.

Le worker reçoit seulement les trois valeurs numériques, la date source, la version du schéma et des messages de contrôle bornés. Il vérifie l’origine, le chemin, l’identifiant de l’extension, la fenêtre principale, l’onglet et le document de chaque message. Les captures sont acceptées uniquement de son onglet temporaire. Les données et les métadonnées de traitement restent dans `chrome.storage.session` privé aux contextes de l’extension : mémoire du profil, effacée au redémarrage du navigateur ou rechargement/désactivation de l’extension. Aucune utilisation de storage.local/sync, localStorage ou IndexedDB pour les soldes.

La fermeture du nouvel onglet après acquittement conserve la capture jusqu’à son expiration. Le dashboard possède aussi son propre minuteur d’expiration. La déconnexion Microsoft efface immédiatement l’affichage et demande au worker de purger le cache et d’arrêter le traitement courant. Elle ne déconnecte pas MyAbacus. Une session expirée, un contexte ambigu ou un chargement trop long affiche un état à vérifier et ne déclenche aucune saisie d’identifiants automatique.

L’extension transmet ses réponses uniquement au chemin autorisé du dashboard dans ce profil. Le contrôle du compte Microsoft dans le front évite un affichage accidentel ; il ne constitue pas une authentification Entra du worker. Un script exécuté sur la page autorisée a accès aux valeurs qu’elle affiche. Cette intégration locale ne remplace pas une API serveur protégeant des données partagées.

## Mise à jour et retrait

Après remplacement des fichiers, cliquer **Recharger** sur la carte de l’extension dans `edge://extensions`, puis recharger le dashboard. Pour retirer l’intégration, désactiver ou supprimer l’extension dans cette même page.

## Vérification

Depuis la racine du workspace :

```text
node extension-myabacus/verify-reader.mjs
node extension-myabacus/verify-protocol.mjs
node extension-myabacus/verify-capture.mjs
node extension-myabacus/verify-scripts.mjs
node verify-myabacus.mjs
```

Ces tests utilisent des valeurs fictives. Aucun solde personnel n’est enregistré dans les sources, tests ou archive.
