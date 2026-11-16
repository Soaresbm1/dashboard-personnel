# Dashboard · Football ANF

Cette extension Edge lit les trois derniers scores publics de chaque équipe sur le calendrier officiel de l’ANF : **FC Le Locle · Juniors A**, **FC Le Parc · Swiss Futsal Premier League** et **FC Le Parc 2 · 1ère ligue Futsal**. Elle fonctionne sans connexion à l’ANF.

## Installation dans Edge

1. Ouvrir `edge://extensions` et activer **Mode développeur**.
2. Cliquer sur **Charger l’extension décompressée** et sélectionner le dossier décompressé `extension-football`.
3. Vérifier que la carte **Dashboard · Football ANF**, version **1.1.0**, est activée. Pour mettre à jour une installation existante, cliquer sur **Recharger** sur cette carte.
4. Recharger le [dashboard](https://soaresbm1.github.io/dashboard-personnel/) dans le même profil Edge.

L’ID attendu est `alepjbcpdhcadcbggjgelichkenlmepc`. La clé publique du manifeste stabilise cet ID lorsque le dossier est déplacé ou l’extension rechargée.

## Fonctionnement

Tous les cinq jours, lorsque Edge est lancé, l’extension vérifie les trois équipes, une par une. Elle ouvre son propre onglet inactif sur le calendrier de l’équipe concernée, attend la page complète, vérifie l’équipe et lit les scores présents dans le tableau de matchs. Une rencontre est retenue seulement si les deux scores sont numériques et si son coup d’envoi remonte à au moins trois heures. Les rencontres non comptabilisées ou sans heure confirmée sont ignorées. Les trois résultats de chaque équipe sont triés du plus récent au plus ancien.

La programmation reste de cinq jours, avec une date de dernière tentative et un dernier relevé valide propres à chaque équipe. La mise à jour récupère les anciennes données des Juniors A et lance une première lecture des deux nouvelles équipes. Le redémarrage d’Edge ou l’ouverture du dashboard ne relance pas une équipe avant son échéance. Si Edge était fermé à l’échéance, les vérifications de rattrapage sont mises en file à son prochain démarrage. Une lecture manuelle reporte la prochaine vérification automatique de cette équipe à cinq jours après cette tentative. Un échec ne supprime ni les dernières données valides ni leur date d’origine.

L’onglet se ferme après la lecture s’il est resté en arrière-plan. Si vous l’avez sélectionné ou si vous avez changé sa page, il reste ouvert. La tentative expire au bout de 90 secondes. Un blocage de la page ou une lecture incomplète conserve les dernières données valides avec leur date d’origine.

Le bouton de l’extension permet de choisir une équipe, de consulter l’état de sa lecture et de demander une nouvelle tentative. Les demandes manuelles d’une même équipe sont espacées d’au moins trente secondes. Après une mise à jour du dossier, cliquer sur **Recharger** sur sa carte dans `edge://extensions`, puis recharger le dashboard.

## Données et autorisations

Les seules permissions sont `storage`, `alarms` et l’accès au domaine public `matchcenter-anf.football.ch` ; la version 1.1.0 n’en ajoute aucune. Le script de lecture vérifie exactement les paramètres `a=pt`, `lng=2`, `oid=15`, ainsi que la paire équipe/club : `34107/919`, `74009/902` ou `68914/902`. Il extrait les noms des équipes, les scores, la date, la compétition et un lien fixe vers le calendrier concerné. Ces informations sportives et l’état de la dernière tentative sont conservés dans le stockage local de l’extension. Les équipes et leurs variantes de noms sont validées séparément pour empêcher le mélange des résultats.

Le dashboard communique par la messagerie externe d’Edge. Le manifeste et le service limitent cette entrée à `https://soaresbm1.github.io/dashboard-personnel/` et `index.html`. L’extension ne charge aucun script sur le dashboard. Le lecteur intervient seulement sur la page publique ANF créée pour sa propre tentative.

## Interface avec le dashboard

```js
chrome.runtime.sendMessage('alepjbcpdhcadcbggjgelichkenlmepc', {
  type: 'GET_RESULTS',
  protocol: 'dashboard-football-v1',
  teamId: '74009'
}, response => {
  // Lire chrome.runtime.lastError si l’extension n’est pas disponible.
});
```

`teamId` accepte les chaînes `34107`, `74009` et `68914`. Son omission conserve le comportement des anciennes versions pour les Juniors A (`34107`). `GET_RESULTS` renvoie immédiatement le dernier relevé de cette équipe et lance une lecture en arrière-plan si les cinq jours sont écoulés. `REFRESH_RESULTS` demande une lecture manuelle, avec un délai minimal de trente secondes par équipe.

Réponse :

```text
{ installed:true, protocol:'dashboard-football-v1', version:'1.1.0', teamId:'74009',
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
