# Dashboard · Football ANF

Cette extension Edge lit les trois derniers scores publics du **FC Le Locle · Juniors A**, sur le calendrier officiel de l’ANF. Elle fonctionne sans connexion à l’ANF.

## Installation dans Edge

1. Ouvrir `edge://extensions` et activer **Mode développeur**.
2. Cliquer sur **Charger l’extension décompressée** et sélectionner ce dossier : `extension-football`.
3. Vérifier que la carte **Dashboard · Football ANF**, version **1.0.1**, est activée. Pour mettre à jour une installation existante, cliquer sur **Recharger** sur cette carte.
4. Recharger le [dashboard](https://soaresbm1.github.io/dashboard-personnel/) dans le même profil Edge.

L’ID attendu est `alepjbcpdhcadcbggjgelichkenlmepc`. La clé publique du manifeste stabilise cet ID lorsque le dossier est déplacé ou l’extension rechargée.

## Fonctionnement

Tous les cinq jours, lorsque Edge est lancé, l’extension ouvre son propre onglet inactif sur le [calendrier des Juniors A](https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=34107&v=919). Elle attend la page complète, vérifie l’équipe et lit les scores présents dans le tableau de matchs. Une rencontre est retenue seulement si les deux scores sont numériques et si son coup d’envoi remonte à au moins trois heures. Les trois résultats sont triés du plus récent au plus ancien.

La mise à jour remplace l’ancienne programmation de quinze minutes et conserve la date de la dernière tentative. Le redémarrage d’Edge ou l’ouverture du dashboard ne déclenche pas de nouvelle lecture avant les cinq jours. Si Edge était fermé à l’échéance, une seule vérification de rattrapage est lancée à son prochain démarrage. Une lecture manuelle reste possible et reporte la prochaine vérification automatique à cinq jours après cette tentative. Les dernières données valides sont conservées entre deux contrôles et en cas d’échec.

L’onglet se ferme après la lecture s’il est resté en arrière-plan. Si vous l’avez sélectionné ou si vous avez changé sa page, il reste ouvert. La tentative expire au bout de 90 secondes. Un blocage de la page ou une lecture incomplète conserve les dernières données valides avec leur date d’origine.

Le bouton de l’extension permet de consulter l’état de la lecture et de demander une nouvelle tentative. Les demandes manuelles sont espacées d’au moins trente secondes. Après une mise à jour du dossier, cliquer sur **Recharger** sur sa carte dans `edge://extensions`, puis recharger le dashboard.

## Données et autorisations

Les seules permissions sont `storage`, `alarms` et l’accès au domaine public `matchcenter-anf.football.ch`. Le script de lecture vérifie exactement le calendrier `t=34107`, `v=919`, `a=pt`, `lng=2`, `oid=15`. Il extrait les noms des équipes, les scores, la date, la compétition et un lien fixe vers ce calendrier. Ces informations sportives et l’état de la dernière tentative sont conservés dans le stockage local de l’extension.

Le dashboard communique par la messagerie externe d’Edge. Le manifeste et le service limitent cette entrée à `https://soaresbm1.github.io/dashboard-personnel/` et `index.html`. L’extension ne charge aucun script sur le dashboard. Le lecteur intervient seulement sur la page publique ANF créée pour sa propre tentative.

## Interface avec le dashboard

```js
chrome.runtime.sendMessage('alepjbcpdhcadcbggjgelichkenlmepc', {
  type: 'GET_RESULTS',
  protocol: 'dashboard-football-v1'
}, response => {
  // Lire chrome.runtime.lastError si l’extension n’est pas disponible.
});
```

`GET_RESULTS` renvoie immédiatement le dernier relevé et lance une lecture en arrière-plan si les cinq jours sont écoulés. `REFRESH_RESULTS` demande une lecture manuelle, avec un délai minimal de trente secondes.

Réponse :

```text
{ installed:true, protocol:'dashboard-football-v1', version:'1.0.1',
  resultsState:'ready'|'unavailable', results:[],
  resultsCheckedAt:ISO_UTC|null, resultsCheckFailed:boolean, refreshing:boolean }
```

Chaque résultat contient `id`, `home`, `away`, `startsAt`, `timeConfirmed`, `scoreHome`, `scoreAway`, `league`, `url`. Le score respecte l’ordre domicile–extérieur. La réponse ne contient que les trois derniers résultats et des métadonnées de lecture. Un résultat absent ne devient pas un zéro.

## Vérification

Depuis ce dossier :

```text
node --test tests
node --check background.mjs
node --check source.js
node --check popup.js
```

Les tests couvrent le calendrier exact, les scores absents et nuls, les dates suisses, les marqueurs de direct et d’annulation, les messages non autorisés, la protection des onglets utilisés, l’expiration, la reprise du service worker et la conservation des derniers résultats.

Références de l’API : [messagerie externe Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#external-webpage), [permissions des onglets](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions), [alarmes](https://developer.chrome.com/docs/extensions/reference/api/alarms).
