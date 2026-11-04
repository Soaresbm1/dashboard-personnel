# Dashboard · MyAbacus local (Edge)

Extension personnelle Manifest V3. Elle lit les compteurs **déjà affichés** dans la vue personnelle In & Out et les transmet localement au dashboard, dans le même profil Edge. Ce connecteur local n’utilise pas l’API Abacus et ne nécessite aucun accès Q910/Q981.

## Installation

1. Dans Edge, ouvrir **Extensions → Gérer les extensions** (`edge://extensions`).
2. Activer **Mode développeur**, puis **Charger l’extension non empaquetée**.
3. Choisir ce dossier `extension-myabacus`, contenant `manifest.json` (décompresser l’archive d’abord si nécessaire).
4. Recharger le [dashboard](https://soaresbm1.github.io/dashboard-personnel/) et se connecter avec son compte Microsoft propriétaire habituel.
5. Dans le **même profil Edge**, ouvrir [MyAbacus](https://abaprod.isp-spi.ch/portal/myabacus/), se connecter directement au portail puis ouvrir **In & Out**. Sélectionner la date d’aujourd’hui ; l’interface doit être en français.
6. Garder In & Out ouvert. Le dashboard lit l’état local toutes les 20 secondes ; la source inspecte les champs affichés toutes les 5 secondes. L’icône de l’extension rappelle ces instructions.

Une éventuelle politique d’entreprise interdisant les extensions non empaquetées doit être respectée ; l’extension ne modifie aucune politique Edge.

## Données et limites

- Solde d’heures **total**, en heures décimales signées.
- Vacances restantes **à ce jour**, en jours.
- Vacances disponibles **après la planification au 31 décembre**, en jours ; cette valeur reste distincte du solde courant.
- Date affichée par MyAbacus et date de lecture locale.

La date « Lu à » correspond à la première lecture de ces valeurs dans le document, ou à leur dernier changement visible. Un contrôle de présence ne rajeunit pas cette date. Au-delà de 15 minutes, la lecture est marquée ancienne. **L’extension ne recharge pas MyAbacus, ne déclenche aucun recalcul sur son serveur et ne garantit pas l’actualité de la source.** Les compteurs suivent les changements du portail lorsqu’il les affiche. Aucun fonctionnement navigateur fermé.

La lecture s’arrête si la date n’est pas aujourd’hui en Suisse, si le compte affiché n’est pas celui attendu, si la page ne correspond pas au lien personnel In & Out de sa navigation, si un autre sélecteur est présent ou si les libellés sont ambigus. Un changement de présentation/langue de MyAbacus peut nécessiter une adaptation. Une valeur absente n’est jamais remplacée par zéro.

## Confidentialité et lecture seule

L’unique permission explicite est `storage`. Les scripts sont limités au portail MyAbacus de cette installation et au chemin exact du dashboard. Pas de `cookies`, `webRequest`, `debugger`, API de saisie, appel réseau, mot de passe, jeton ni lecture d’un magasin interne de MyAbacus. Les champs de pointage et les boutons de saisie ne sont jamais manipulés.

Le worker reçoit seulement les trois valeurs numériques, la date source et la version du schéma. Il vérifie l’origine, le chemin, l’identifiant de l’extension, la fenêtre principale, l’onglet et le document de chaque message. Les données restent dans `chrome.storage.session` privé aux contextes de l’extension : mémoire du profil, effacée au redémarrage du navigateur ou rechargement/désactivation de l’extension. Aucune utilisation de storage.local/sync, localStorage ou IndexedDB pour les soldes.

La fermeture/navigation de la source envoie un effacement immédiat lorsque le navigateur le permet. En l’absence de signal de présence, les données expirent en 90 secondes ; le dashboard possède son propre minuteur d’expiration. La déconnexion Microsoft efface immédiatement l’affichage et la copie en mémoire de la page. Elle ne déconnecte pas MyAbacus. La copie de l’extension peut subsister tant que sa page MyAbacus reste ouverte.

L’extension transmet ses réponses uniquement au chemin autorisé du dashboard dans ce profil. Le contrôle du compte Microsoft dans le front évite un affichage accidentel ; il ne constitue pas une authentification Entra du worker. Un script exécuté sur la page autorisée a accès aux valeurs qu’elle affiche. Cette intégration locale ne remplace pas une API serveur protégeant des données partagées.

## Mise à jour et retrait

Après remplacement des fichiers, cliquer **Recharger** dans la fiche de l’extension sur `edge://extensions`, puis recharger les deux onglets. Pour retirer l’intégration, désactiver ou supprimer l’extension dans cette même page.

## Vérification

Depuis la racine du workspace :

```text
node extension-myabacus/verify-reader.mjs
node extension-myabacus/verify-protocol.mjs
node extension-myabacus/verify-scripts.mjs
node verify-myabacus.mjs
```

Ces tests utilisent des valeurs fictives. Aucun solde personnel n’est enregistré dans les sources, tests ou archive.
