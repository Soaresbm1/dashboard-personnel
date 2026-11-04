# Dashboard — Vue d’ensemble

Un dashboard personnel statique, en français et adapté aux ordinateurs et téléphones.

Une page unique de consultation regroupe l’agenda Outlook et les tâches et tickets attribués dans l’intranet. Les deux listes de travail sont visibles simultanément, avec leurs statuts, priorités, échéances et liens d’origine. L’interface utilise des tons neutres et ne propose aucune création de contenu, projet, note, habitude ou minuteur. Les seuls réglages concernent les connexions Microsoft.

## Vue compacte

Sur ordinateur, le résumé et les accès rapides précèdent une grille unique : agenda à gauche, tâches et tickets côte à côte à droite, puis courrier et dernière publication en dessous. La date est regroupée dans l’en-tête. La publication montre son titre, sa date et son contenu mis en forme : paragraphes, titres, listes, gras, italique, soulignement, citations, mentions et liens cliquables. Le contenu long défile à l’intérieur du panneau ; les liens s’ouvrent dans un nouvel onglet.

À partir de 1040 × 650 pixels utiles, les quatre panneaux et leurs actions tiennent dans la hauteur de l’écran. Seules les listes longues défilent à l’intérieur de leur panneau, avec accès au clavier. Les éléments des listes chargées restent accessibles. Sur petit écran, après zoom ou en présence d’un message d’erreur, la page peut s’allonger pour conserver une lecture complète.

## Courrier, accès rapides et actualités internes

Le courrier présente les cinq derniers messages non lus de la boîte de réception, ou les cinq derniers messages d’importance haute, lus ou non. Le compteur du titre indique toujours le nombre total de non-lus de la boîte de réception. Les requêtes Microsoft Graph utilisent uniquement `Mail.ReadBasic` déléguée et sélectionnent les sujets, expéditeurs, dates, importance, état lu/non lu et liens Outlook. Aucun corps, aperçu du corps ou pièce jointe n’est demandé. Ouvrir un lien conduit dans Outlook ; le dashboard n’envoie ni ne modifie aucun mail.

La permission `Mail.ReadBasic` s’ajoute à `Calendars.ReadBasic` dans l’inscription Entra de `dashboard`, avec consentement administrateur si l’affectation est obligatoire. L’accès reste limité au même propriétaire. Au chargement, la session existante est reprise silencieusement ; un consentement ou une validation Microsoft nécessaire demande un clic explicite, sans popup automatique. [Permission Microsoft Graph](https://learn.microsoft.com/en-us/graph/permissions-reference#mailreadbasic), [lecture des messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).

Les accès rapides ouvrent le courrier Outlook, le calendrier, Teams et l’intranet, sans formulaire de création.

### Annuaire interne et salles

Deux boutons compacts, « Annuaire » et « Salles », complètent les accès rapides sans ajouter de panneau à la grille. Chacun ouvre une fenêtre accessible au clavier, fermable avec Échap et son bouton Fermer. L’annuaire permet une recherche locale par nom, fonction, service et adresse mail dans les contacts autorisés par l’intranet. Les adresses mail sont cliquables. Aucun contact n’est enregistré dans le stockage du dashboard.

L’annuaire utilise `GET /api/dashboard/v1/directory` avec le jeton `Dashboard.Read` existant et les mêmes contrôles du propriétaire côté serveur. Seuls les profils disponibles dans l’annuaire habituel sont inclus ; les profils désactivés ou archivés sont exclus. La réponse est limitée à 1000 contacts avec un indicateur explicite si d’autres sont disponibles dans l’annuaire complet.

Les salles proviennent de Microsoft Graph v1.0 Places avec la permission déléguée `Place.Read.All`. Cette permission nécessite un consentement administrateur et permet la lecture des lieux de l’organisation ; l’application conserve son affectation obligatoire au seul propriétaire. La disponibilité est consultée avec `Calendars.ReadBasic`, déjà utilisé par l’agenda : `POST /me/calendar/getSchedule` est une requête de lecture, par lots de 20 salles, sur les 30 prochaines minutes. Les calculs utilisent UTC ; les sujets, organisateurs et détails des réunions ne sont ni affichés ni conservés par le dashboard. Aucune réservation n’est effectuée. Une réponse absente, ambiguë ou en erreur n’est jamais présentée comme une salle libre. Un résultat vide de Places signifie qu’aucune salle n’a été retournée, sans déduire qu’il n’existe aucune salle dans l’organisation.

Les deux outils suivent la connexion Microsoft commune, la déconnexion, les changements de configuration et l’actualisation automatique. Les réponses restent uniquement en mémoire. Sources Microsoft : [liste des lieux](https://learn.microsoft.com/en-us/graph/api/place-list?view=graph-rest-1.0), [permission Place.Read.All](https://learn.microsoft.com/en-us/graph/permissions-reference#placereadall), [lecture des disponibilités](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0).

Activation : déployer d’abord la route annuaire et approuver `Place.Read.All` pour l’application `dashboard` avant de publier cette version frontend. Ne pas publier le nouveau périmètre de connexion tant que le consentement nécessaire n’a pas été accordé, afin de préserver la connexion commune existante.

Les actualités internes proviennent de `GET https://intranet.isp-spi.ch/api/dashboard/v1/latest-post`, avec le jeton intranet `Dashboard.Read`, distinct du jeton Graph. Le serveur vérifie le propriétaire et applique les mêmes règles d’audience que le fil de l’intranet. Le bloc présente uniquement la publication visible la plus récente, toutes rubriques confondues, selon sa date de publication puis son identifiant en cas d’égalité. Les épingles et niveaux d’importance ne modifient pas ce choix ; brouillons et publications futures restent exclus, y compris ceux de l’auteur. Le champ `contentHtml` reprend le HTML enregistré par l’intranet ou sa version échappée pour un ancien corps en texte brut. Le navigateur le parse dans un template inerte, puis reconstruit uniquement les éléments de mise en forme autorisés, sans recopier d’attributs arbitraires, de scripts, de formulaires ou de médias. Les liens HTTP, HTTPS et mailto sont conservés après validation ; les liens relatifs sont résolus sur l’URL de la publication dans l’intranet. Les nouveaux onglets utilisent `noopener noreferrer` et `no-referrer`. Un HTML dépassant 5000 nœuds ou 128 niveaux utilise le texte complet de repli ; aucune fin de publication n’est tronquée. Le champ `content` intégral en texte brut et l’extrait historique restent compatibles avec les anciennes réponses. Si aucune publication n’est disponible, un message l’indique. Le lien paginé peut se déplacer si le fil change avant son ouverture. L’ancien endpoint `/api/dashboard/v1/news` reste disponible pour les anciennes versions du dashboard.

Ces deux aperçus utilisent la même actualisation automatique et la même déconnexion Microsoft que les blocs existants. Leur contenu reste uniquement en mémoire ; il n’est ni stocké dans le navigateur ni transmis à GitHub. Les erreurs de session retirent les données ; un incident réseau temporaire conserve le dernier affichage et son horodatage.

## Résumé et ordre de priorité

Une ligne discrète présente le prochain rendez-vous de la période sélectionnée, le nombre de tâches en retard et le nombre de tickets prioritaires (bloquants ou priorité élevée). Un rendez-vous en cours est signalé, les événements terminés sont écartés et les titres privés restent masqués. Les compteurs concernent les éléments ouverts reçus ; une limite de l’API est indiquée dans le résumé. « — » signifie que les données ne sont pas disponibles, tandis que « 0 » correspond à une lecture réussie sans élément concerné.

Les tâches et les tickets sont classés séparément : bloquants ou en retard, échéances du jour, priorités élevées, puis autres éléments. Dans chaque groupe, la priorité puis l’échéance la plus proche départagent les éléments, avec un ordre stable en cas d’égalité. Les éléments clôturés éventuellement reçus sont placés à la fin et exclus des compteurs d’urgence. Le résumé suit les actualisations, signale les données anciennes et s’efface avec les listes lors d’une déconnexion ou d’un refus d’accès.

## Actualisation automatique

L’agenda et les deux listes de travail se mettent à jour chaque minute lorsque la page est visible et le navigateur en ligne. Le retour sur l’onglet ou le rétablissement du réseau déclenche une mise à jour, avec au moins cinq secondes entre deux tentatives rapprochées. Les demandes en cours ne sont pas doublées et les délais `Retry-After` sont respectés.

Les données déjà chargées restent affichées pendant une mise à jour automatique. En cas d’incident temporaire, le dashboard indique que le dernier affichage est conservé et garde son horodatage précédent. Une session expirée ou un refus d’accès retire les données et demande une reconnexion explicite, sans popup automatique. Les boutons d’actualisation manuelle restent disponibles. La date de la page et la période de l’agenda suivent aussi le changement de jour.

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

« Rétablir les réglages du dashboard » retire les identifiants personnalisés et reprend les réglages publics de cette application, sans supprimer la possibilité de tout reconnecter. Le contrôle de l’identité reste obligatoire après cette réinitialisation.

« Tout reconnecter » rétablit l’agenda, les mails, les tâches/tickets et les actualités avec une seule connexion Microsoft. Le bouton commun apparaît lorsqu’au moins un bloc attend une reconnexion ; il reste accessible dans le menu Connexions. Les quatre boutons de connexion individuels sont retirés de la vue. Après validation du propriétaire, chaque bloc reprend silencieusement avec son propre jeton : Microsoft Graph pour Outlook, API intranet pour le travail et la publication. Les jetons ne sont jamais partagés entre ces deux destinations. Le choix d’un autre compte ou l’annulation n’amorce aucun service ; une déconnexion pendant la connexion invalide son résultat tardif. Les clics simultanés partagent une seule fenêtre Microsoft. Les permissions existantes et les restrictions de compte restent identiques.

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

## Météo locale

Le résumé affiche les conditions prévues actuellement à **Neuchâtel, Suisse** : température en °C, conditions et minimum/maximum du jour dans le fuseau `Europe/Zurich`. La météo utilise [Open-Meteo](https://open-meteo.com/), dont le lien d’attribution figure près des données, avec les coordonnées fixes `46.99179, 6.93100`. Aucune géolocalisation, clé API ou permission Microsoft n’est nécessaire. Seule la requête météo publique est envoyée au fournisseur, sans identifiant ni jeton du dashboard.

Le chargement se fait à l’ouverture, puis toutes les 15 minutes lorsque la page est visible et en ligne. Le retour à la page ou au réseau rattrape une actualisation échue. Le délai réseau est limité à 12 secondes. Une panne conserve le dernier relevé récent avec une indication explicite ; au-delà d’une heure de validité ou au changement de jour local, le relevé est retiré. Les valeurs nulles ou les unités inattendues ne sont jamais présentées comme une température de zéro. Les données restent en mémoire uniquement.

Documentation : [API et codes météo](https://open-meteo.com/en/docs), [conditions d’utilisation personnelle et attribution](https://open-meteo.com/en/terms).

## Publication avec GitHub Pages

Les fichiers du site sont à la racine du dépôt. Dans **Settings → Pages**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Aucun build ni dépendance n’est nécessaire.

Le fichier `.nojekyll` conserve la publication des fichiers statiques sans traitement Jekyll. Les chemins des ressources sont relatifs et compatibles avec une adresse de projet comme `/dashboard-personnel/`.
