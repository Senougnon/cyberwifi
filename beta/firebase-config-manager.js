// firebase-config-manager.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, get, set, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfigs = [
    { databaseURL: "https://cyber1-51916-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber2-8ca5c-default-rtdb.firebaseio.com" }, // REPLACE with your actual URLs
    { databaseURL: "https://cyber3-95820-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber4-1b446-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber5-60f70-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber6-eff66-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber7-2296f-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber8-88ca0-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber9-54c58-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber10-52907-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber11-6eae0-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber12-85de8-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber13-79b7b-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber14-69b05-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber15-8e74f-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://cyber16-b8d33-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://fnmcwifi-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://will-dccf0-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://sic-wifi-zone-default-rtdb.firebaseio.com" }, // REPLACE
    { databaseURL: "https://evisions-84300-default-rtdb.firebaseio.com" } // REPLACE

    // Add more configurations as needed
];

const MAX_CONNECTIONS = 15000; // Limite de connexions
let app;
let db;
//let currentDatabaseIndex = -1; // No longer needed with Firebase persistence
let initializationPromise;
const META_DB_INDEX = 0; // Use the first config for metadata.  VERY IMPORTANT!

// Initialise une instance de l'application Firebase avec un index donné.
function initializeAppWithIndex(index) {
    const config = firebaseConfigs[index];
    if (!config) {
        throw new Error(`Invalid database index: ${index}`);
    }
    const appName = `app${index}`;
    try {
      app = initializeApp(config, appName);
    } catch (error) {
        if (error.code === 'app/duplicate-app') {
            // App already initialized, use existing instance
          app = getApp(appName);
        } else {
            throw error; // Re-throw unexpected errors
        }
    }

    db = getDatabase(app);
    console.log(`Firebase initialized with database ${index + 1}`);
    return db;
}

// Récupère le compteur de connexions, en l'initialisant si nécessaire.
async function getOrCreateConnectionCounter(db, index) {
    const counterRef = ref(db, 'connectionCounter');
    const snapshot = await get(counterRef);
    if (!snapshot.exists()) {
        await set(counterRef, 0);
        console.log(`Connection counter initialized for database ${index + 1}`);
        return 0;
    }
    return snapshot.val();
}

// Synchronise les données d'une base de données à une autre.
async function synchronizeData(oldIndex, newIndex) {
    if (oldIndex === -1) return; // Pas de synchronisation si c'est la première initialisation

    console.log("Starting database synchronization...");

    const oldDb = initializeAppWithIndex(oldIndex); // Initialiser avec l'ancien index
    const newDb = initializeAppWithIndex(newIndex); // Initialiser avec le nouvel index

    const dataPathsToSync = ['users', 'users-data'];

    for (const path of dataPathsToSync) {
        try {
            const oldDataRef = ref(oldDb, path);
            const newDataRef = ref(newDb, path);
            const snapshot = await get(oldDataRef);
            const dataToSync = snapshot.val();

            if (dataToSync) {
                await set(newDataRef, dataToSync);
                console.log(`Data synchronized for path: ${path}`);
            }
        } catch (error) {
            console.error(`Error synchronizing path ${path}:`, error);
            throw new Error(`Error during synchronization: ${error.message}`);
        }
    }
    console.log("Database synchronization complete.");
    //Important : reinitialisation du compteur a 0 apres synchronisation
    await set(ref(oldDb, 'connectionCounter'), 0);
}


async function getCurrentDatabaseIndex() {
    const metaDb = initializeAppWithIndex(META_DB_INDEX);
    const indexRef = ref(metaDb, 'currentDatabaseIndex');
    const snapshot = await get(indexRef);
    if (snapshot.exists()) {
        return snapshot.val();
    } else {
        // Initialize if it doesn't exist.
        await set(indexRef, 0);
        return 0;
    }
}

async function setCurrentDatabaseIndex(index) {
    const metaDb = initializeAppWithIndex(META_DB_INDEX);  // Always use the first config for meta-data
    const indexRef = ref(metaDb, 'currentDatabaseIndex');
    await set(indexRef, index);
}
// Sélectionne la base de données active, gère la rotation et la synchronisation.
async function selectDatabase() {
    let databaseIndex;
    let dbToUse;

    // 1.  Récupérer l'index actuel depuis Firebase (metaDb)
    databaseIndex = await getCurrentDatabaseIndex();

    // 2. Initialiser l'app Firebase avec l'index
    dbToUse = initializeAppWithIndex(databaseIndex);

    // 3. Récupérer le compteur de connexions (ou l'initialiser)
    let connectionCount = await getOrCreateConnectionCounter(dbToUse, databaseIndex);

    // 4. Vérifier si la limite est atteinte
    if (connectionCount >= MAX_CONNECTIONS) {
        // 5. Rotation de la base de données
        const oldIndex = databaseIndex;
        databaseIndex = (databaseIndex + 1) % firebaseConfigs.length; // Rotation circulaire
        console.log(`Switching to database index: ${databaseIndex}`);

        // 6. Synchroniser les données
        await synchronizeData(oldIndex, databaseIndex)
            .catch(error => {
                console.error("Synchronization failed:", error);
                throw error; // Important : Propager l'erreur
            });

        // 7. Initialiser la nouvelle base de données
        dbToUse = initializeAppWithIndex(databaseIndex);
        // 8. Récupérer/initialiser le compteur de la nouvelle base de données
        connectionCount = await getOrCreateConnectionCounter(dbToUse, databaseIndex); // Initialisation a 0
        // 9.  Mettre à jour l'index dans Firebase (metaDb)
        await setCurrentDatabaseIndex(databaseIndex);
    }


    return dbToUse; // Retourner la base de données *avant* d'incrémenter

}

// Fonction pour incrémenter le compteur de connexions (transaction Firebase)
async function incrementConnectionCounter(db) {
    const counterRef = ref(db, 'connectionCounter');
    try {
        await runTransaction(counterRef, (currentCount) => {
            // Si currentCount est null (n'existe pas), il sera initialisé à 0 par getOrCreateConnectionCounter
            return (currentCount || 0) + 1;
        });
    } catch (error) {
        console.error("Error incrementing connection counter:", error);
        throw error; // Important : Propager l'erreur
    }
}

// Fonction exportée pour obtenir la base de données active.
export async function getActiveDatabase() {
    if (!initializationPromise) {
          initializationPromise = selectDatabase()
              .then(async (selectedDb) => {
                await incrementConnectionCounter(selectedDb); // Incrémenter *après* la sélection
                 return selectedDb;

              });

    }
     return initializationPromise; // attend et retourne la db
}

// No longer needed:  selectDatabase().catch(error => console.error("Initial database selection error:", error));