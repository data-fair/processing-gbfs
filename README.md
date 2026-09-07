# @data-fair/processing-gbfs

Charge un service GBFS (vélos, voitures et trottinettes en libre-service) dans data-fair.

Le traitement lit le fichier de découverte `gbfs.json` d'un service, en **version 2.x ou
3.0**, et alimente jusqu'à six jeux de données, chacun activable indépendamment :

| Jeu | Contenu | Flux GBFS |
|---|---|---|
| Métadonnées | jeu sans données, porteur des fichiers JSON du service en pièces jointes | `system_information` |
| Stations | un point par station, avec sa disponibilité | `station_information` ⋈ `station_status` |
| Véhicules | un point par véhicule disponible, avec son modèle et son tarif | `vehicle_status` ⋈ `vehicle_types` |
| Types de véhicules | catalogue des modèles proposés | `vehicle_types` |
| Tarifs | grille tarifaire, barèmes rendus lisibles | `system_pricing_plans` |
| Zones de circulation | une ligne par zone et par règle | `geofencing_zones` |

Les jeux de données sont des jeux REST, **entièrement remplacés à chaque exécution** :
ils reflètent l'état courant du service, jamais son historique. Les flux annoncent leur
fraîcheur avec un `ttl`, souvent de 300 secondes ; planifier le traitement toutes les 5 à
15 minutes est un rythme raisonnable.

Les jeux produits sont reliés entre eux par `relatedDatasets`, et ces liens sont
rafraîchis à chaque exécution.

## Versions supportées

La spécification GBFS a beaucoup bougé entre 2.x et 3.0. Les différences sont absorbées
par `lib/gbfs/normalize.ts`, et le reste du code ne voit que la forme 3.0 :

| | GBFS 2.x | GBFS 3.0 |
|---|---|---|
| Libellés | `"name": "Gare"` | `"name": [{ "text": "Gare", "language": "fr" }]` |
| Instants | `1660312061` (POSIX) | `"2026-08-12T14:47:41+02:00"` (RFC3339) |
| Véhicules | `free_bike_status.json`, `bike_id`, `bikes` | `vehicle_status.json`, `vehicle_id`, `vehicles` |
| Disponibilité | `num_bikes_available` | `num_vehicles_available` |
| Découverte | `data.<langue>.feeds` | `data.feeds` |

Un flux que le service ne publie pas est signalé puis ignoré : le jeu de données
correspondant n'est pas produit, les autres le sont.

## Validation

Le traitement s'appuie sur [gbfs-validator](https://github.com/MobilityData/gbfs-validator),
le validateur de référence de la communauté GBFS — celui qui alimente
[gbfs-validator.mobilitydata.org](https://gbfs-validator.mobilitydata.org). Il est
embarqué comme dépendance et **tourne dans le traitement** : le flux n'est envoyé à aucun
service tiers, contrairement au plugin GTFS qui poste son archive à un
`transport-validator`. En contrepartie il relit lui-même les fichiers du service avec son
propre client HTTP, ce qui double les requêtes vers celui-ci, et n'offre aucun moyen
d'interrompre une validation en cours.

L'onglet **Traitement** en règle l'usage :

| Réglage | Effet |
|---|---|
| Mode « Valider uniquement » | Contrôle le flux, écrit le résumé dans le journal, ne produit aucun jeu de données. L'onglet « Jeux de données » disparaît. |
| Valider le flux avant l'import | Actif par défaut : le résumé est écrit dans le journal, l'import se poursuit quoi qu'il arrive. |
| Échouer si le flux contient des anomalies | Interrompt le traitement dès qu'un fichier **obligatoire** est absent ou invalide. Un fichier optionnel en erreur ne bloque jamais : le flux reste exploitable. |
| Anomalies détaillées maximum par fichier | Ne borne que le détail écrit en `debug`. Les compteurs restent exhaustifs. |

Le validateur couvre les versions 1.0 à 3.0 (plus la 3.1-RC3). Une version qu'il ne
connaît pas donne un avertissement, jamais un échec.

## Concepts

Les colonnes reconnues par le vocabulaire standard sont annotées automatiquement :
libellé, description, adresse, code postal, latitude, longitude, géométrie, téléphone et
page web.

Restent les deux identifiants qui relient les jeux produits entre eux, et pour lesquels
le vocabulaire standard n'a pas d'équivalent. Le traitement leur pose deux concepts
qu'il définit lui-même :

| Concept | Colonnes annotées |
|---|---|
| `https://github.com/data-fair/processing-gbfs#station` | `station_id` dans les stations et dans les véhicules |
| `https://github.com/data-fair/processing-gbfs#vehicle-type` | `vehicle_type_id` dans les véhicules et dans les types de véhicules |

Ces URI sont posées dans tous les cas. Tant qu'elles ne sont déclarées nulle part, elles
restent inertes : `fixConcepts` cherche l'URI dans le vocabulaire standard puis dans le
vocabulaire privé du propriétaire, ne la trouve pas, et laisse la colonne sans
`x-concept`. Tout ce qui consomme un concept dans data-fair compare à des URI connues,
donc rien ne se déclenche.

Pour les activer, déclarez deux concepts dans l'onglet **Vocabulaire privé** des
paramètres de l'organisation, en reprenant ces URI dans leurs identifiants. Les jeux
existants seront annotés à l'exécution suivante.

Une colonne qui porte déjà un concept posé à la main n'est jamais écrasée : le
traitement ne pose le sien que sur une colonne qui n'en a aucun.

## Développement

```sh
npm install
npm run build-types   # génère les types depuis processing-config-schema.json
npm run lint
npm run test
```

Les tests unitaires n'ont besoin de rien : ils tournent sur des extraits réels du service
Citiz Grand Poitiers (3.0) et sur un service 2.2 synthétique, dans `test-it/resources/`.

Le test d'intégration a besoin d'une instance data-fair, à déclarer dans
`config/local-test.mjs` (git-ignoré) :

```js
export default {
  dataFairUrl: 'https://staging-koumoul.com/data-fair',
  dataFairAPIKey: '...'
}
```

## Publication

`npm version minor && git push --follow-tags`. Un push sur `main` publie vers le registre
de staging, un tag `v*` publie en production.
