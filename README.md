# Mon espace — Dashboard personnel

Un dashboard personnel statique, en français et adapté aux ordinateurs et téléphones.

Il regroupe les tâches et leurs échéances, les projets et leur progression, les habitudes quotidiennes, les notes, les raccourcis et un minuteur de concentration.

## Données personnelles

Les tâches, projets, habitudes et notes sont sauvegardés uniquement dans le navigateur utilisé (localStorage), sans synchronisation entre appareils. Le menu « Personnaliser » permet d’exporter ou d’importer une copie JSON. Un changement d’adresse du site utilise un espace de sauvegarde distinct : exportez vos données avant de les transférer sur la nouvelle adresse.

Les tâches et habitudes initiales sont des suggestions à personnaliser.

## Agenda Outlook professionnel

Le bloc « Mon agenda Outlook » permet une connexion Microsoft 365 en lecture seule et affiche les événements du jour ou de la semaine du calendrier principal, y compris les occurrences de réunions récurrentes. Le site interroge directement Microsoft Graph après connexion. Les événements, comptes Microsoft et jetons restent en mémoire et ne sont ni envoyés à GitHub ni inclus dans les exports JSON. Une actualisation de la page nécessite une nouvelle connexion Microsoft. Seuls les identifiants publics d’application et de locataire sont enregistrés localement, séparément des données du dashboard.

### Configuration Microsoft Entra

1. Inscrire une application **locataire unique** dans Microsoft Entra.
2. Enregistrer la plateforme **Application à page unique (SPA)** avec cette adresse de retour exacte : `https://soaresbm1.github.io/dashboard-personnel/auth-redirect.html`.
3. Ajouter l’autorisation Microsoft Graph **déléguée** `Calendars.ReadBasic`. Aucun secret client ni autorisation d’application sur toutes les boîtes aux lettres n’est utilisé.
4. Dans l’application d’entreprise, activer **Affectation requise ? = Oui**, puis affecter uniquement le compte utilisateur prévu, sans groupe. Une affectation obligatoire nécessite l’approbation administrative des autorisations déléguées. Les privilèges inhérents aux administrateurs généraux du tenant restent applicables.
5. Dans « Configurer Outlook » sur le dashboard, enregistrer l’ID d’application (client) et l’ID d’annuaire (locataire), puis choisir « Connecter Microsoft 365 ».

Le site GitHub Pages reste public. La restriction des comptes est appliquée par Microsoft Entra, et non par un filtrage d’adresse e-mail dans le JavaScript public. La connexion ne modifie pas les rendez-vous. Déconnecter le calendrier efface les événements affichés et le cache d’authentification de cette application sans déconnecter les autres services Microsoft.

Documentation : [MSAL Browser](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/about-msal-browser), [accès réservé aux utilisateurs affectés](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users), [calendrier Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0).

### Bibliothèque d’authentification

Microsoft MSAL Browser 5.27.0 et son redirect bridge sont empaquetés dans `vendor/`, avec leur licence. Pour les reconstruire : `npm ci`, puis `npm run build:auth`. Les versions sont verrouillées dans `package-lock.json`. Les fichiers déjà générés sont servis directement par GitHub Pages ; aucun build n’est nécessaire pour publier.

## Tâches et tickets de l’intranet

Le bloc « Mon intranet » lit les éléments attribués au compte connecté, au travers de l’API `https://intranet.isp-spi.ch/api/dashboard/v1/work`. Il affiche séparément les tâches et les tickets, leurs statuts, priorités et échéances. Chaque lien ouvre la fiche d’origine. Les éléments restent en lecture seule et ne sont jamais ajoutés aux tâches locales, sauvegardés dans localStorage ou inclus dans les exports JSON. Une déconnexion ou une erreur de récupération retire les éléments affichés.

### Activation

1. Déployer l’API de lecture de l’intranet et la configurer avec l’identité immuable du seul compte autorisé. L’API vérifie ce compte et ses attributions côté serveur, indépendamment du navigateur.
2. Déclarer l’API dans Microsoft Entra avec une permission **déléguée** `api://<ID-application-API>/Dashboard.Read`, puis autoriser l’application SPA « dashboard » à demander cette permission. La permission Outlook `Calendars.ReadBasic` reste séparée : un jeton Microsoft Graph n’est jamais envoyé à l’intranet.
3. Conserver la redirection SPA déjà enregistrée : `https://soaresbm1.github.io/dashboard-personnel/auth-redirect.html`. Autoriser uniquement l’origine `https://soaresbm1.github.io` dans les réglages CORS de l’API.
4. Dans « Configurer la connexion intranet », vérifier puis enregistrer l’ID de l’application du dashboard, l’ID du locataire et l’ID de l’application API. Les identifiants publics de ce déploiement personnel sont préremplis pour éviter une copie manuelle. Une configuration intranet déjà sauvegardée reste prioritaire ; sinon, les identifiants Outlook existants sont proposés pour le dashboard et le locataire. Le préremplissage ne sauvegarde rien, ne charge pas Microsoft et ne lance aucune connexion avant validation de l’utilisateur. Aucun secret, jeton ou identifiant personnel n’est demandé.
5. Choisir « Connecter l’intranet » avec le compte autorisé. Le navigateur doit pouvoir joindre l’intranet ; le réseau professionnel ou son VPN peut être nécessaire.

Les connexions Outlook et intranet ont chacune leur cache MSAL en mémoire. Déconnecter l’intranet ne déconnecte pas les autres services Microsoft. Une actualisation de la page nécessite de se reconnecter. Le module refuse les redirections réseau et ne transmet son jeton qu’à l’adresse API fixe ci-dessus. L’accès est refusé par défaut tant que l’API n’est pas activée et correctement configurée.

## Publication avec GitHub Pages

Les fichiers du site sont à la racine du dépôt. Dans **Settings → Pages**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Aucun build ni dépendance n’est nécessaire.

Le fichier `.nojekyll` conserve la publication des fichiers statiques sans traitement Jekyll. Les chemins des ressources sont relatifs et compatibles avec une adresse de projet comme `/dashboard-personnel/`.
