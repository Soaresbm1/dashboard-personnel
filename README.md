# Dashboard — Vue d’ensemble

Un dashboard personnel statique, en français et adapté aux ordinateurs et téléphones.

Une page unique de consultation regroupe l’agenda Outlook et les tâches et tickets attribués dans l’intranet. Les deux listes de travail sont visibles simultanément, avec leurs statuts, priorités, échéances et liens d’origine. L’interface utilise des tons neutres et ne propose aucune création de contenu, projet, note, habitude ou minuteur. Les seuls réglages concernent les connexions Microsoft.

## Données personnelles

Les données de travail proviennent uniquement d’Outlook et de l’intranet ; aucun contenu de démonstration n’est affiché. Les éventuelles anciennes données personnelles sous la clé `mon-espace-v1` restent intactes dans le navigateur, sans être utilisées ni modifiées par cette vue de consultation.

## Agenda Outlook professionnel

Le panneau « Agenda » permet une connexion Microsoft 365 en lecture seule et affiche les événements du jour ou de la semaine du calendrier principal, y compris les occurrences de réunions récurrentes. Le site interroge directement Microsoft Graph après connexion. Les événements restent uniquement en mémoire ; ils ne sont ni envoyés à GitHub ni inclus dans des exports. Microsoft MSAL conserve les informations de connexion dans son cache localStorage pour retrouver le compte et renouveler les jetons automatiquement après rechargement. Le code du dashboard ne copie jamais les jetons dans ses propres données. Le menu « Connexions » regroupe les paramètres Outlook, les paramètres intranet et la déconnexion Microsoft commune.

### Configuration Microsoft Entra

1. Inscrire une application **locataire unique** dans Microsoft Entra.
2. Enregistrer la plateforme **Application à page unique (SPA)** avec cette adresse de retour exacte : `https://soaresbm1.github.io/dashboard-personnel/auth-redirect.html`.
3. Ajouter l’autorisation Microsoft Graph **déléguée** `Calendars.ReadBasic`. Aucun secret client ni autorisation d’application sur toutes les boîtes aux lettres n’est utilisé.
4. Dans l’application d’entreprise, activer **Affectation requise ? = Oui**, puis affecter uniquement le compte utilisateur prévu, sans groupe. Une affectation obligatoire nécessite l’approbation administrative des autorisations déléguées. Les privilèges inhérents aux administrateurs généraux du tenant restent applicables.
5. Les identifiants publics de ce déploiement sont déjà intégrés. Choisir « Connecter Microsoft 365 » avec le compte autorisé. Les réglages avancés permettent de conserver une configuration personnalisée existante.

Le site GitHub Pages reste public. La restriction des comptes est appliquée par Microsoft Entra et par l’API intranet. Le navigateur ne restaure que l’identité immuable du propriétaire prévue pour ce déploiement (locataire et OID), sans se fier à l’adresse email. La connexion ne modifie pas les rendez-vous. « Déconnecter Microsoft » retire les deux listes affichées, désactive la restauration automatique et purge le cache MSAL du compte utilisé, sans terminer la session Microsoft des autres sites. Cette déconnexion est aussi répercutée dans les autres onglets ouverts du dashboard.

### Connexion mémorisée

Outlook et l’intranet partagent une instance MSAL pour le même client et locataire. Au chargement, une connexion déjà choisie est reprise avec `acquireTokenSilent`, séparément pour chaque permission. Aucun popup ne s’ouvre automatiquement. Une validation Microsoft nécessaire fait apparaître « Reconnecter ». Après la mise à jour depuis l’ancien cache en mémoire, effectuer une première connexion pour initialiser le cache persistant. Pour conserver la session après fermeture complète du navigateur, accepter « Rester connecté » si Microsoft le propose ; les règles de l’organisation et les expirations continuent de s’appliquer. [Documentation du cache MSAL](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/caching).

Documentation : [MSAL Browser](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/about-msal-browser), [accès réservé aux utilisateurs affectés](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users), [calendrier Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0).

### Bibliothèque d’authentification

Microsoft MSAL Browser 5.27.0 et son redirect bridge sont empaquetés dans `vendor/`, avec leur licence. Pour les reconstruire : `npm ci`, puis `npm run build:auth`. Les versions sont verrouillées dans `package-lock.json`. Les fichiers déjà générés sont servis directement par GitHub Pages ; aucun build n’est nécessaire pour publier.

## Tâches et tickets de l’intranet

Le panneau « Tâches et tickets » lit les éléments attribués au compte connecté, au travers de l’API `https://intranet.isp-spi.ch/api/dashboard/v1/work`. Les deux listes sont visibles simultanément avec leurs statuts, priorités et échéances. Chaque lien ouvre la fiche d’origine. Les éléments restent en lecture seule et ne sont jamais ajoutés aux tâches locales ni sauvegardés dans localStorage. Une déconnexion ou une erreur de récupération retire les éléments affichés.

### Activation

1. Déployer l’API de lecture de l’intranet et la configurer avec l’identité immuable du seul compte autorisé. L’API vérifie ce compte et ses attributions côté serveur, indépendamment du navigateur.
2. Déclarer l’API dans Microsoft Entra avec une permission **déléguée** `api://<ID-application-API>/Dashboard.Read`, puis autoriser l’application SPA « dashboard » à demander cette permission. La permission Outlook `Calendars.ReadBasic` reste séparée : un jeton Microsoft Graph n’est jamais envoyé à l’intranet.
3. Conserver la redirection SPA déjà enregistrée : `https://soaresbm1.github.io/dashboard-personnel/auth-redirect.html`. Autoriser uniquement l’origine `https://soaresbm1.github.io` dans les réglages CORS de l’API.
4. Les identifiants publics de ce déploiement personnel sont disponibles sans copie manuelle. Une configuration intranet déjà sauvegardée reste prioritaire ; les réglages avancés proposent aussi les identifiants Outlook existants. Aucun secret n’est demandé.
5. Choisir « Connecter l’intranet » avec le compte autorisé. Le navigateur doit pouvoir joindre l’intranet ; le réseau professionnel ou son VPN peut être nécessaire.

La connexion Microsoft est partagée avec Outlook et mémorisée dans ce navigateur. Les tâches et tickets restent en mémoire, hors du cache d’authentification et des exports. Une annulation de connexion ou une erreur de récupération intranet n’efface pas le cache Outlook. Le module refuse les redirections réseau et ne transmet son jeton qu’à l’adresse API fixe ci-dessus. L’accès est refusé par défaut tant que l’API n’est pas activée et correctement configurée.

## Publication avec GitHub Pages

Les fichiers du site sont à la racine du dépôt. Dans **Settings → Pages**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Aucun build ni dépendance n’est nécessaire.

Le fichier `.nojekyll` conserve la publication des fichiers statiques sans traitement Jekyll. Les chemins des ressources sont relatifs et compatibles avec une adresse de projet comme `/dashboard-personnel/`.
