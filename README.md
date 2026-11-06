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

Le résumé réunit le prochain rendez-vous de la période sélectionnée, les trois prochains départs de Pont des Parcs vers la gare nord et la météo de Neuchâtel. Les anciens compteurs de tâches en retard et de tickets prioritaires ont été retirés de cette ligne. Un rendez-vous en cours est signalé, les événements terminés sont écartés et les titres privés restent masqués. « — » indique que l’agenda n’est pas disponible ; les transports et la météo ont leurs propres états de chargement et de panne.

Les tâches et les tickets sont classés séparément dans leur panneau : bloquants ou en retard, échéances du jour, priorités élevées, puis autres éléments. Dans chaque groupe, la priorité puis l’échéance la plus proche départagent les éléments, avec un ordre stable en cas d’égalité. Les éléments clôturés éventuellement reçus sont placés à la fin. Le résumé de l’agenda suit les actualisations, signale les données anciennes et s’efface lors d’une déconnexion ou d’un refus d’accès ; les transports et la météo publics restent indépendants de Microsoft.

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

## Notifications regroupées

Une cloche dans l’en-tête ouvre les notifications du dashboard. Elle rassemble les mails non lus présents dans l’aperçu, puis les nouvelles attributions de tâches/tickets, les changements de titre, statut, priorité ou échéance et les nouvelles publications détectées pendant que cette page est ouverte. Le premier chargement des tâches et des actualités établit une référence silencieuse. Les nouvelles attributions ne sont signalées qu’après une référence complète ; une ancienne publication réexposée ou un changement de filtre mail ne devient pas une fausse nouveauté.

Le centre réutilise les objets normalisés des trois services, sans nouvelle requête ni permission. L’aperçu mail et la dernière publication gardent leurs limites existantes ; le centre ne constitue pas un historique exhaustif. Il conserve jusqu’à 30 notifications, dédupliquées par élément, avec des registres d’identifiants bornés. **Marquer comme vue** et **Tout marquer comme vu** concernent uniquement le dashboard : aucun mail, ticket ou publication n’est modifié.

Les titres, liens et états restent uniquement en mémoire pour cette page, sans corps de mail, contenu HTML de publication ni jeton. Une déconnexion, un changement de configuration, une révocation ou une réponse non sûre retire les informations de la source concernée. Une panne transitoire les conserve avec une indication explicite de données anciennes. Le changement d’identité efface le centre pour éviter tout mélange de comptes ; fermer ou recharger la page réinitialise cette vue.

## Transports publics — Pont des Parcs vers Neuchâtel, gare nord

Le résumé affiche directement les **trois prochains départs de Pont des Parcs vers Neuchâtel, gare nord**, à côté de la météo, à la place des anciens compteurs de tâches en retard et tickets prioritaires. Chaque ligne indique la ligne de bus, la destination, **départ → arrivée à la gare**, puis le compte à rebours. Le lien **Tous les départs** ouvre les six prochains bus depuis l’arrêt exact **Neuchâtel, Pont des Parcs**, identifiant `8593564`, avec destination, heure prévue et prévision/retard lorsqu’ils sont fournis. Seules les courses dont la destination est **Neuchâtel, gare nord** sont conservées ; les deux sens du même numéro de ligne ne sont jamais confondus. La requête charge jusqu’à 30 départs de l’arrêt avant filtrage. Les deux vues partagent la même requête et s’actualisent ensemble. Les heures sont affichées dans le fuseau `Europe/Zurich`. Un simple horaire n’est pas présenté comme une prévision et aucune information d’annulation non fournie n’est déduite.

L’arrivée est lue dans le dernier checkpoint valide de la gare nord (`8579625`) du parcours fourni pour chaque course. Une prévision d’arrivée cohérente est prioritaire, sinon l’arrivée planifiée est indiquée comme prévue. L’arrivée doit suivre le départ correspondant ; un pseudo-stop sans arrivée planifiée ou une heure incohérente n’est pas utilisé. Si l’arrivée ne peut pas être déterminée, le bloc affiche `—`, sans ajouter une durée fixe ni répercuter arbitrairement le retard de départ. Les heures et leur nature prévue/estimée restent accessibles aux lecteurs d’écran et dans les détails. Les sous-champs du parcours sont inclus dans la même requête, sans appel supplémentaire par bus.

L’API publique [Opendata.ch](https://transport.opendata.ch/docs.html) est interrogée sans clé, géolocalisation ni identifiant Microsoft, chaque minute lorsque la page est visible et en ligne. La requête ne charge que l’arrêt et les champs utiles aux départs. Les données restent en mémoire. Le compte à rebours évolue localement et les départs dépassés disparaissent. En panne, les anciens horaires sont signalés et aucun compte à rebours actuel n’est affirmé ; les données sont retirées après trois minutes. Les requêtes sont bornées à 12 secondes, et une réponse de surcharge suspend les nouvelles tentatives.

La source [opentransportdata.swiss](https://opentransportdata.swiss/) et l’API sont citées dans la fenêtre des départs. L’intégration ne change aucune permission Microsoft ou route de l’intranet.

## Disponibilité de l’intranet

La grande pastille dans le résumé, à droite de GitHub, montre le dernier état HTTP observé depuis GitHub : verte en ligne, rouge pour un code d’erreur (404, 503, etc.), un accès refusé, une redirection inattendue ou une panne réseau. Il vérifie anonymement la page d’entrée web, en suivant uniquement les redirections HTTPS sur le même domaine. Si elle conduit normalement à l’autorisation Microsoft, il vérifie aussi le point de santé Laravel `/up` sans visiter Microsoft. Le détail au survol distingue le code de la page d’accès de celui de l’application. Il ne teste pas toutes les fonctions authentifiées de l’application. Aucune session ni donnée personnelle n’est envoyée au contrôle.

Le workflow `Intranet availability` prévoit un contrôle toutes les cinq minutes et publie uniquement le code HTTP, la date, la durée et une catégorie d’erreur sur la branche `intranet-status`. Le dashboard lit ce résultat public chaque minute, sans jeton. Le dernier résultat validé est mémorisé localement pour survivre à un rechargement. Un relevé ancien, un échec de lecture ou un navigateur hors ligne conserve sa couleur et son code ; le détail précise alors que le dernier statut connu est conservé. La date et l’heure visibles correspondent au contrôle du site, pas à la lecture du résultat. Un résultat plus ancien ne remplace jamais un relevé plus récent. Seule l’absence de tout statut connu affiche une pastille neutre. L’historique est celui de la branche de contrôle ; le code du site sur main n’est pas modifié par ces vérifications.

La fréquence de cinq minutes est une planification, pas une garantie : GitHub peut retarder ou abandonner des événements planifiés en période de charge. Recharger le dashboard relit le résultat disponible et ne lance pas une nouvelle vérification du site. Un lancement de secours est disponible dans Actions → Intranet availability → Run workflow, sans modifier la session Microsoft. La planification utilise les minutes explicites 2, 7, 12, …, 57, hors du début d’heure.

## Suivi GitHub

La vue conserve des accents discrets par service. Dans le résumé GitHub, un anneau montre la répartition des dépôts suivis avec ou sans PR ouverte ; les lectures inconnues restent dans une catégorie grise, sans être comptées comme zéro. Le nombre au centre représente les dépôts avec PR, pas le nombre de PR. Le graphique suit les mêmes données, dates, limites et règles de déconnexion que le suivi existant, sans nouvelle requête. Les animations d’apparition sont désactivées si le système demande de réduire les mouvements.

Le bloc compact, placé dans le résumé du haut à côté de la météo, suit les dépôts du compte `Soaresbm1` : nombre de dépôts, total des PR ouvertes (brouillons compris), publications en échec et sélecteur de dépôt pour consulter sa dernière publication de production et ses modifications en attente. Les liens ouvrent GitHub en lecture seule. Aucun lancement, fusion ou modification n’est proposé.

L’API propriétaire `GET https://intranet.isp-spi.ch/api/dashboard/v1/github` utilise la permission Microsoft existante `Dashboard.Read`. L’actualisation et le cache serveur durent cinq minutes ; la page suspend les lectures hors ligne et dans un onglet masqué. Les métadonnées et le dépôt sélectionné restent uniquement en mémoire ; une panne transitoire conserve les dernières valeurs datées, une déconnexion ou un refus confirmé les retire.

La découverte filtre strictement le propriétaire Soaresbm1 et traite jusqu’à 30 dépôts, les plus récemment mis à jour. Une limite atteinte ou une lecture partielle est indiquée, sans faux compteur zéro. La production est identifiée parmi les 20 derniers déploiements ; les prévisualisations et les tests CI ne sont pas présentés comme des publications de production. Les compteurs de PR sont bornés à 100 par dépôt et indiquent `100+` à cette limite.

Un jeton personnel GitHub à permissions fines est prévu pour les dépôts Soaresbm1, avec **Deployments: Read-only**, **Pull requests: Read-only** et **Metadata: Read-only**. Il reste exclusivement sur Infomaniak dans `storage/app/private/dashboard-github-soares-token`, en mode 600, hors du répertoire public. Ne jamais l’inclure dans le dépôt, le JavaScript, une URL ou une discussion. Le nom des dépôts privés n’est pas inscrit dans les fichiers publics du site. L’ancien accès ISP-SPI n’est pas utilisé par cette intégration.

## Publication avec GitHub Pages

Les fichiers du site sont à la racine du dépôt. Dans **Settings → Pages**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Aucun build ni dépendance n’est nécessaire.

Le fichier `.nojekyll` conserve la publication des fichiers statiques sans traitement Jekyll. Les chemins des ressources sont relatifs et compatibles avec une adresse de projet comme `/dashboard-personnel/`.
