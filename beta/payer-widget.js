// Wrap everything in an IIFE to avoid polluting the global scope
(function() {
// --- Configuration Variables (Determined asynchronously) ---
// These will hold the determined adminUserId and fedapayApiKey after checking URL params and Firebase lookup.
let adminUserId = null;
let fedapayApiKey = null; // This is the PUBLIC key for FedaPay.init

// Define the config manager path
// IMPORTANT: This path is relative to the HTML file loading this script (payer.html).
const firebaseConfigManagerPath = './firebase-config-manager.js'; // Ensure this path is correct

// --- Configuration for Retries ---
const MAX_LOAD_RETRIES = 5; // Nombre maximum de tentatives de chargement des dépendances
const RETRY_DELAY_MS = 2500; // Délai en millisecondes entre les tentatives (2.5 secondes)
// Utiliser MAX_SALE_RESERVATION_ATTEMPTS pour la recherche de ticket unique dans initPayment
const MAX_SALE_RESERVATION_ATTEMPTS = 10; // Max attempts to find a non-duplicate ticket instance for sale

// --- Widget State ---
let db = null; // Initialize db as null
// availableTicketsCache now holds the RAW TicketsTotal structure for UI display only.
// Filtering out sold ones happens dynamically in initPayment.
let availableTicketsCache = {};
let widgetInitialized = false;
let fetchedPrivateApiKey = null; // NEW: Variable to store the fetched Private API Key

// FedaPay API URL for transaction search - NEW CONSTANT
const FEDAPAY_SEARCH_API_URL = 'https://api.fedapay.com/v1/transactions/search';


// --- DOM Element References ---
// These will be assigned during the setup process
let payTicketButton, ratesSection, loadingMessage, optionsContainer, notificationPopup, notificationTitle, notificationMessage;
let checkTicketButton; // NEW: Reference for the new button
let searchModal; // NEW: The modal container for search
let searchInput; // NEW: The text input field in search modal
let searchButton; // NEW: The search trigger button in search modal
let searchMessage; // NEW: The message display area in search modal
let searchLoader; // NEW: The loading spinner in search modal


// --- Firebase SDK Modules (to be loaded dynamically) ---
// These will be assigned during the dynamic import.
// getActiveDatabase will be from the config manager, ref, get, etc. from firebase-database.
// Importation de runTransaction est nécessaire pour la nouvelle logique
let getActiveDatabase, ref, get, set, push, remove, runTransaction;

// --- Main Setup Function ---
// This function will handle parsing URL, determining config, loading dependencies,
// initializing DB, and proceeding with widget logic.
async function startWidgetSetup() {
    console.log("Widget: Starting main setup process...");

    const widgetContainer = document.getElementById('fedapay-ticket-widget-container');
    if (!widgetContainer) {
        console.error("Fedapay Widget Critical Error: Could not find the main widget container #fedapay-ticket-widget-container. Widget cannot initialize.");
        // Attempt to display error message even without the container
        document.body.innerHTML = "<p style='color: red; text-align: center; margin-top: 50px;'>Fedapay Widget Critical Error: Could not find the main widget container #fedapay-ticket-widget-container. Widget cannot initialize.</p>";
        return;
    }

    // Get essential DOM elements early to display loading/errors
    ratesSection = widgetContainer.querySelector('.widget-rates-section');
    loadingMessage = widgetContainer.querySelector('.widget-loading-message');
    optionsContainer = widgetContainer.querySelector('#widget-dynamic-ticket-options');
    notificationPopup = widgetContainer.querySelector('.widget-notification');
     // Get the main button reference early
    payTicketButton = widgetContainer.querySelector('#widget-payTicketButton');

    // Check if essential elements are found - CRITICAL ERROR
    if (!ratesSection || !loadingMessage || !optionsContainer || !notificationPopup || !payTicketButton) {
        const missingElement = !ratesSection ? '.widget-rates-section' :
                               !loadingMessage ? '.widget-loading-message' :
                               !optionsContainer ? '#widget-dynamic-ticket-options' :
                               !notificationPopup ? '.widget-notification' :
                               !payTicketButton ? '#widget-payTicketButton' : 'unknown';
        const msg = `Fedapay Widget Critical Error: Could not find required HTML element "${missingElement}" within the widget container.`;
        console.error(msg);
         widgetContainer.innerHTML = `<p style='color: red; text-align: center;'>${msg}</p>`; // Replace content on critical error
        return; // Abort initialization
    }
     // Also check notification sub-elements if notificationPopup is found - CRITICAL ERROR
     notificationTitle = notificationPopup.querySelector('#widget-notification-title');
     notificationMessage = notificationPopup.querySelector('#widget-notification-message');
     if (!notificationTitle || !notificationMessage) {
          const msg = "Erreur critique: Éléments de notification manquants (#widget-notification-title ou #widget-notification-message).";
          console.error("Fedapay Widget Critical Error:", msg);
          widgetContainer.innerHTML = `<p style='color: red; text-align: center;'>${msg}</p>`; // Replace content on critical error
          return; // Abort initialization
     }

    console.log("Widget: Essential DOM elements found.");

    // Show initial loading message and hide other sections until state is determined
    loadingMessage.textContent = "Chargement des composants...";
    loadingMessage.style.display = 'block';
    optionsContainer.style.display = 'block';
    ratesSection.style.display = 'block'; // Hide rates section initially
    payTicketButton.style.display = 'block'; // Hide pay button initially


    // --- Add the "Ticket payé non reçu ?" button ---
    checkTicketButton = document.createElement('button');
    checkTicketButton.id = 'widget-ticketNotReceivedButton'; // Assign the ID from CSS
    checkTicketButton.textContent = 'Ticket payé non reçu ?';
    checkTicketButton.className = 'widget-check-ticket-button'; // Assign the class from CSS

    // Add click listener to show the search modal (defined below)
    checkTicketButton.addEventListener('click', showSearchModal);

    // Insert the new button immediately after the main payTicketButton
    if (payTicketButton && payTicketButton.parentNode) {
        payTicketButton.parentNode.insertBefore(checkTicketButton, payTicketButton.nextSibling);
        console.log("Widget: 'Ticket payé non reçu ?' button added.");
        checkTicketButton.style.display = 'block'; // Hide check button initially
    } else {
         console.warn("Widget: Could not add 'Ticket payé non reçu ?' button, main button parent not found.");
    }
    // --- End of adding "Ticket payé non reçu ?" button ---


     // --- Create and Add the Search Modal ---
     searchModal = document.createElement('div');
     searchModal.id = 'widget-search-modal'; // Assign the ID from CSS
     searchModal.className = 'widget-search-modal'; // Assign the class from CSS
     searchModal.innerHTML = `
         <h2>Rechercher un Ticket</h2>
         <span class="widget-close-icon">×</span>
         <p>Entrez l'id de transaction reçu par SMS après votre paiement.</p>
         <input type="text" placeholder="ID de Transaction" id="widget-search-input">
         <button id="widget-search-button">Rechercher</button>
         <div class="widget-search-message" id="widget-search-message"></div>
          <div class="widget-search-loader" id="widget-search-loader"></div>
     `;
     widgetContainer.appendChild(searchModal);
     console.log("Widget: Search modal added to container.");

     // Get references to the new modal elements AFTER appending
     searchInput = searchModal.querySelector('#widget-search-input');
     searchButton = searchModal.querySelector('#widget-search-button');
     searchMessage = searchModal.querySelector('#widget-search-message');
     searchLoader = searchModal.querySelector('#widget-search-loader');
     const searchModalCloseIcon = searchModal.querySelector('.widget-close-icon');


     // Add event listeners for modal elements
     if (searchModalCloseIcon) {
         searchModalCloseIcon.addEventListener('click', hideSearchModal);
     }
     if (searchButton) {
         searchButton.addEventListener('click', handleSearchTicket);
     }
     if (searchInput) {
         // Allow searching by pressing Enter key in the input field
         searchInput.addEventListener('keypress', function(event) {
             if (event.key === 'Enter') {
                 event.preventDefault(); // Prevent form submission if it's part of a form
                 handleSearchTicket();
             }
         });
     }
     // --- End of Create and Add Search Modal ---


    // --- Load Firebase dependencies with Retry Logic ---
    let loadAttempts = 0;
    let dependenciesLoaded = false;
    let dbFunctions, configManager; // Variables to hold imported modules

    while (loadAttempts < MAX_LOAD_RETRIES && !dependenciesLoaded) {
        loadAttempts++;
        if (loadAttempts > 1) {
            loadingMessage.textContent = `Tentative de chargement ${loadAttempts}/${MAX_LOAD_RETRIES}... (Connexion instable détectée)`;
            console.log(`Widget: Waiting ${RETRY_DELAY_MS / 1000}s before retry #${loadAttempts}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }

        console.log(`Widget: Attempting to load dependencies (Attempt ${loadAttempts})`);
        try {
            // Attempt to load both dependencies, including runTransaction
            const dbFunctionsPromise = import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js");
            const configManagerPromise = import(firebaseConfigManagerPath);

            // Wait for both promises to resolve
            [dbFunctions, configManager] = await Promise.all([dbFunctionsPromise, configManagerPromise]);

            // Assign functions if successful
            ref = dbFunctions.ref;
            get = dbFunctions.get;
            set = dbFunctions.set;
            push = dbFunctions.push;
            remove = dbFunctions.remove;
            runTransaction = dbFunctions.runTransaction; // Assign runTransaction
            getActiveDatabase = configManager.getActiveDatabase;

            // Check if runTransaction was actually imported (older versions might not have it)
            if (typeof runTransaction !== 'function') {
                 throw new Error("Firebase Database SDK version does not support runTransaction.");
            }

            console.log("Widget: Firebase SDK and Config Manager loaded successfully.");
            dependenciesLoaded = true; // Set flag to exit loop

        } catch (error) {
            console.warn(`Fedapay Widget Error: Failed to load dependencies on attempt ${loadAttempts}.`, error);
            // If runTransaction check failed, log a more specific error
             if (error.message.includes('runTransaction')) {
                  console.error("Fedapay Widget Critical Error: Incompatible Firebase SDK version or missing runTransaction function.");
             }
        }
    } // --- End of Dependency Retry Loop ---

    // Check if dependencies were loaded successfully after all attempts - CRITICAL ERROR
    if (!dependenciesLoaded) {
        const msg = "Erreur critique: Impossible de charger les composants requis après plusieurs tentatives. Veuillez vérifier votre connexion internet ou l'accès aux fichiers Firebase.";
        console.error("Fedapay Widget Critical Error:", msg);
        loadingMessage.textContent = msg;
        loadingMessage.style.display = 'block'; // Ensure final error message is visible
        // Hide all main sections on critical error

        db = null;
        removeStoredTicketLocally(); // Clear local storage on critical failure
        return; // STOP widget setup
    }

    // --- Dependencies loaded successfully, proceed to determine config ---
    console.log("Widget: Dependencies loaded. Determining configuration...");
    loadingMessage.textContent = "Détermination de la configuration...";


    let determinedAdminUserId = null;
    let determinedApiKey = null; // This will be the PUBLIC key from config/shortlink
    let mainAdminUserIdForLookup = null; // Needed for shortlink lookup

    const urlParams = new URLSearchParams(window.location.search);
    const shortParam = urlParams.get('s'); // Check for the new 's' parameter

    if (shortParam) {
        console.log(`Widget: Found short parameter 's': ${shortParam}. Attempting lookup.`);
        loadingMessage.textContent = "Recherche de la configuration...";

        // Parse the short parameter: {mainAdminId}_{shortcode}
        const parts = shortParam.split('_');
        if (parts.length === 2 && parts[0] && parts[1]) {
            mainAdminUserIdForLookup = parts[0];
            const shortcode = parts[1];

            try {
                // Use the temp DB instance from the config manager to read the `shortenedLinks` node
                const lookupDb = await getActiveDatabase(mainAdminUserIdForLookup);
                 if (!lookupDb) throw new Error("Failed to initialize temporary database for lookup.");

                const lookupRef = ref(lookupDb, `users-data/${mainAdminUserIdForLookup}/shortenedLinks/${shortcode}`);
                const snapshot = await get(lookupRef);

                if (snapshot.exists()) {
                    const linkData = snapshot.val();
                    if (linkData && linkData.userId && linkData.apiKey) {
                        determinedAdminUserId = linkData.userId; // This is the target admin ID (managed account)
                        determinedApiKey = linkData.apiKey; // This is the PUBLIC API key for this user
                        console.log(`Widget: Lookup successful. Determined user: ${determinedAdminUserId}, PUBLIC API key: ${determinedApiKey ? determinedApiKey.substring(0,8)+'...' : 'N/A'}`);
                         loadingMessage.textContent = "Configuration trouvée.";
                    } else {
                        const msg = "Erreur: Les données du lien raccourci sont incomplètes ou invalides.";
                         console.error("Widget Error:", msg, linkData);
                         loadingMessage.textContent = msg;
                         // CRITICAL Config Error: Hide all main sections
                         ratesSection.style.display = 'none';
                         optionsContainer.style.display = 'none';
                         payTicketButton.style.display = 'none';
                         if (checkTicketButton) checkTicketButton.style.display = 'none';
                         loadingMessage.style.display = 'block'; // Show error message
                         return; // Abort setup on invalid link data
                    }
                } else {
                     const msg = "Erreur: Lien raccourci introuvable ou expiré.";
                     console.warn("Widget Warning:", msg, shortParam);
                     loadingMessage.textContent = msg;
                     // Non-critical failure (link expired): Show info/search, hide sales
                      ratesSection.style.display = 'block'; // Show title
                      optionsContainer.style.display = 'none'; // Hide options
                      payTicketButton.style.display = 'none'; // Hide pay button
                      if (checkTicketButton) checkTicketButton.style.display = 'block'; // Show search button
                      loadingMessage.style.display = 'block'; // Show error message
                     return; // Abort setup on link not found (no sales possible)
                }
            } catch (error) {
                 const msg = `Erreur lors de la recherche du lien raccourci : ${error.message}`;
                 console.error("Widget Error:", msg, error);
                 loadingMessage.textContent = msg;
                 // CRITICAL Config Error: Hide all main sections
                 ratesSection.style.display = 'none';
                 optionsContainer.style.display = 'none';
                 payTicketButton.style.display = 'none';
                 if (checkTicketButton) checkTicketButton.style.display = 'none';
                 loadingMessage.style.display = 'block'; // Show error message
                 return; // Abort setup on lookup error
            }

        } else {
            // --- No 's' parameter, fallback to old 'userId' and 'apiKey' parameters or placeholders ---
            // This fallback is kept for compatibility but is less secure/reliable.
            console.log("Widget: No short parameter 's' found. Falling back to userId/apiKey parameters or embedded values.");
            determinedAdminUserId = urlParams.get('userId') || '<!-- ADMIN_USER_ID -->'; // Keep fallback placeholders from original file
            determinedApiKey = urlParams.get('apiKey') || '<!-- FEDAPAY_API_KEY -->'; // Keep fallback placeholders from original file
            loadingMessage.textContent = "Configuration standard détectée (moins sécurisée).";
             console.warn("Widget Warning: Using deprecated URL parameters or placeholders. Use the shortlink 's' parameter for production.");
        }
    } else {
         // --- No 's' parameter, fallback to old 'userId' and 'apiKey' parameters or placeholders ---
         // This fallback is kept for compatibility but is less secure/reliable.
         console.log("Widget: No short parameter 's' found. Falling back to userId/apiKey parameters or embedded values.");
         determinedAdminUserId = urlParams.get('userId') || '<!-- ADMIN_USER_ID -->'; // Keep fallback placeholders from original file
         determinedApiKey = urlParams.get('apiKey') || '<!-- FEDAPAY_API_KEY -->'; // Keep fallback placeholders from original file
         loadingMessage.textContent = "Configuration standard détectée (moins sécurisée).";
          console.warn("Widget Warning: Using deprecated URL parameters or placeholders. Use the shortlink 's' parameter for production.");
    }


    // --- Validate the determined configuration - CRITICAL ERROR ---
    // Note: The fallback placeholders are checked here
    const isPlaceholderUserId = determinedAdminUserId.includes('<!--') || determinedAdminUserId === '';
    const isPlaceholderApiKey = determinedApiKey.includes('<!--') || determinedApiKey === 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY'; // Check against the default string

    if (isPlaceholderUserId || isPlaceholderApiKey) { // Removed isDefaultApiKey check as it's part of isPlaceholderApiKey now
         const msg = "Erreur de configuration: L'ID utilisateur ou la clé API FedaPay est manquant(e) ou invalide. Assurez-vous d'accéder via le lien correct fourni par l'administrateur ou que le portail est correctement déployé.";
         console.error("Fedapay Widget Critical Error:", msg);
         loadingMessage.textContent = msg; // Update loading message with error
         loadingMessage.style.display = 'block'; // Ensure error message is visible
         // Hide all main sections on critical error
         optionsContainer.style.display = 'none';
         ratesSection.style.display = 'none';
         payTicketButton.style.display = 'none';
         if (checkTicketButton) checkTicketButton.style.display = 'none';
         db = null; // Ensure db is null
         removeStoredTicketLocally(); // Clear local storage on critical failure
         return; // STOP execution here if config is invalid
    }

    // --- Configuration is valid, set global variables and initialize main DB ---
    adminUserId = determinedAdminUserId; // Set the global variable for the managed account ID
    fedapayApiKey = determinedApiKey; // Set the global variable for the PUBLIC API Key


    console.log("Widget: Configuration validated. Initializing main database for user:", adminUserId);
    loadingMessage.textContent = "Initialisation de la base de données...";

    try {
         // Initialize the main DB instance using the final determined adminUserId
         // This is the user whose TicketsTotal, VendorsHistory, etc., we will read/write.
         db = await getActiveDatabase(adminUserId); // Pass adminUserId to getActiveDatabase
         if (!db) {
              throw new Error("getActiveDatabase returned null or undefined for main user.");
         }
         console.log("Widget: Main Firebase Database initialized for user:", adminUserId);
         loadingMessage.textContent = "Base de données connectée.";

         // --- Fetch the Private API Key once during initialization ---
         // This is needed for the FedaPay API search function.
         console.log(`Widget: Fetching Private API Key for admin ${adminUserId}...`);
         // Catch error here, but don't abort setup if key fetch fails; search will just be unavailable.
         await fetchPrivateApiKey().catch(err => console.warn(`Widget Warning: Initial Private API Key fetch failed for admin ${adminUserId}:`, err));
         if (!fetchedPrivateApiKey) {
             console.warn(`Widget Warning: Private API Key not available after initial fetch for admin ${adminUserId}. Transaction search by key might fail.`);
         }


    } catch (error) {
        console.error("Fedapay Widget Critical Error: Failed to initialize main Firebase Database:", error);
         const msg = 'Erreur critique: Échec de l\'initialisation de la base de données. Veuillez vérifier votre connexion.';
         loadingMessage.textContent = msg;
         loadingMessage.style.display = 'block';
         // Hide all main sections on critical error
         optionsContainer.style.display = 'none';
         ratesSection.style.display = 'none';
         payTicketButton.style.display = 'none';
         if (checkTicketButton) checkTicketButton.style.display = 'none';
        db = null; // Ensure db is null
         removeStoredTicketLocally(); // Clear local storage on DB init failure
        return; // Abort setup if main DB fails
    }

    // --- Main DB initialized successfully, proceed with widget logic ---
    console.log("Widget: Database ready. Proceeding with sync and listeners.");

    // Add event listeners *after* elements are confirmed to exist (checked early in setup)
    if(payTicketButton) {
         updateButtonText(); // Ensure button text is correct initially
         payTicketButton.addEventListener('click', handlePayTicketButtonClick);
         // payTicketButton.style.display will be set by createTicketOptions
    }
    // checkTicketButton listener added above during creation.
     // checkTicketButton.style.display will be set by createTicketOptions


    // Close icon listener is already safe due to notificationPopup check earlier
    const closeIcon = notificationPopup ? notificationPopup.querySelector('.widget-close-icon') : null;
     if (closeIcon) {
         // Remove potential duplicate listeners before adding
         closeIcon.removeEventListener('click', hideWidgetNotification);
         closeIcon.addEventListener('click', hideWidgetNotification);
     }


    widgetInitialized = true;
    console.log("Fedapay Ticket Widget Initialized successfully.");

     // Initial sync must happen AFTER DB is initialized and config is determined
     // syncTickets will handle the final display state (showing/hiding sections)
    await syncTickets();


    // Start periodic sync only if DB connection is established and adminUserId is valid
    // Check for db here, not just in syncTickets, as syncTickets is also called once initially.
    if (db && adminUserId && !adminUserId.includes('<!--')) {
        setInterval(syncTickets, 5000); // Periodic sync every 60 seconds
         console.log("Widget: Periodic sync started.");
    } else {
        console.warn("Widget: DB/adminId is null/invalid after init, periodic sync will not start.");
    }

} // --- End of startWidgetSetup ---

// --- Utility Functions ---

// Added Loader functions consistent with HTML
const showLoader = () => {
    const loaderWrapper = document.getElementById('loaderWrapper');
    if(loaderWrapper) loaderWrapper.classList.add('active');
};
const hideLoader = () => {
    const loaderWrapper = document.getElementById('loaderWrapper');
    if(loaderWrapper) loaderWrapper.classList.remove('active');
};

// Helper function for basic HTML escaping - Used in createTicketOptions and showWidgetNotification
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>"']/g, function(match) {
        return {
            '&': '&amp;', // Fix: Use &amp; for escaping &
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
             "'": '&#039;'
        }[match];
    });
}

// NEW: Function to fetch the Private API Key from Firebase
// This is called during initialization and needs adminUserId and db
async function fetchPrivateApiKey() {
    if (!db || !adminUserId || adminUserId.includes('<!--')) {
         console.warn("Widget: Cannot fetch Private API Key, DB or adminId missing/invalid.");
        fetchedPrivateApiKey = null; // Ensure it's null if prerequisites fail
        return;
    }
    console.log(`Widget: Attempting to fetch Private API Key for admin ${adminUserId}...`);
    try {
         // Use the new path from index.html config (assumed structure)
        const secretKeyRef = ref(db, `users-data/${adminUserId}/portalConfig/fedapaySecretKey`);
        const snapshot = await get(secretKeyRef);
        if (snapshot.exists() && snapshot.val()) {
            fetchedPrivateApiKey = snapshot.val();
            console.log(`Widget: Private API Key fetched successfully for admin ${adminUserId}.`);
        } else {
            fetchedPrivateApiKey = null; // Key is not configured
            console.warn(`Widget: Private API Key not found in portalConfig for admin ${adminUserId}. Transaction search by key will not work.`);
        }
    } catch (error) {
        console.error(`Widget Error: Failed to fetch Private API Key for admin ${adminUserId}:`, error);
        fetchedPrivateApiKey = null; // Ensure it's null on error
    }
}


// --- Core Logic ---

async function checkSubscriptionStatus() {
     try {
         if (!db || !adminUserId || adminUserId.includes('<!--')) {
             // console.warn("Widget: Database/adminId not available for subscription check."); // Avoid logging this on every sync if DB fails
             return false; // Assume inactive if DB is not available or adminId invalid
         }
         const userAdminRef = ref(db, `users-data/${adminUserId}/admin/subscription`);
         const snapshot = await get(userAdminRef);
         const subscription = snapshot.val();
         const now = Date.now(); // Use timestamp for comparison

         if (subscription && subscription.status === 'active') {
             // Assuming endDate is stored as a timestamp (milliseconds since epoch)
             // If stored as string like "YYYY-MM-DDTHH:mm:ss.sssZ", parse it first:
             const endDateTimestamp = typeof subscription.endDate === 'string' ? new Date(subscription.endDate).getTime() : subscription.endDate;

             if (endDateTimestamp < now) {
                  // Subscription is active status but expired based on date
                 console.warn(`Widget: Admin subscription found but expired on ${new Date(endDateTimestamp).toISOString()}.`);
                 return false;
             } else {
                 // Subscription is active status and not expired
                 // console.log("Widget: Active subscription found."); // Avoid excessive logging
                 return true;
             }
         } else {
             // No subscription data or status is not 'active'
             // console.warn("Widget: No active admin subscription found."); // Avoid excessive logging
             return false;
         }
     } catch (error) {
         console.error("Widget Error: Erreur lors de la vérification de l'abonnement :", error);
         return false; // Assume inactive on error
     }
 }

 // --- NOUVEAU: Fonction pour vérifier si un ticket existe dans l'historique de N'IMPORTE QUEL vendeur ---
 // Cette fonction effectue une lecture LIVE de VendorsHistory à chaque appel.
 async function checkIfTicketSoldInAnyHistory(ticketToCheck) {
     if (!db || !adminUserId || adminUserId.includes('<!--') || !ticketToCheck || !ticketToCheck.user) { // Added adminUserId check
         console.warn("Widget: Cannot check VendorsHistory, DB/adminId/ticket data missing or invalid.");
         return false; // Assume not sold if we can't check
     }
     console.log(`Widget: Checking VendorsHistory for ticket: ${ticketToCheck.user} (Admin: ${adminUserId})`); // Include adminId in log
     const historyRef = ref(db, `users-data/${adminUserId}/VendorsHistory`); // Use adminUserId for path
     try {
         const snapshot = await get(historyRef);
         if (!snapshot.exists()) {
             console.log(`Widget: VendorsHistory node does not exist for admin ${adminUserId}. Ticket assumed not sold.`); // Updated log message
             return false; // No history, so not sold
         }

         const allVendorsHistory = snapshot.val();
         for (const vendorName in allVendorsHistory) {
             const vendorSales = allVendorsHistory[vendorName];
             if (vendorSales && typeof vendorSales === 'object') {
                 for (const saleId in vendorSales) {
                     const sale = vendorSales[saleId];
                     // Compare user and password. Handle missing password gracefully.
                     if (sale && sale.user === ticketToCheck.user && (sale.password || '') === (ticketToCheck.password || '')) {
                         console.log(`Widget: Ticket ${ticketToCheck.user} found in history of vendor: "${vendorName}" for admin ${adminUserId}.`);
                         return true; // Found a match!
                     }
                 }
             }
         }
         // If loops complete without finding a match
         console.log(`Widget: Ticket ${ticketToCheck.user} not found in any vendor history for admin ${adminUserId}.`);
         return false;
     } catch (error) {
         console.error("Widget Error: Failed to fetch or parse VendorsHistory for duplicate check:", error);
         // To avoid blocking sales due to a check failure, assume it's not sold, but log prominently
         console.warn("Widget: Assuming ticket is NOT sold due to error checking VendorsHistory.");
         // Décider si on affiche une notification utilisateur ici ou juste on log l'erreur admin
         // showWidgetNotification("Avertissement", "Impossible de vérifier l'histoire des ventes. La vente continue.", false); // Optionnel - decided against showing this message here
         return false;
     }
 }


// MODIFIED syncTickets: It now ONLY fetches TicketsTotal for display. Filtering is removed.
async function syncTickets() {
    // Basic check for DOM elements before trying to manipulate them
    if (!optionsContainer || !loadingMessage || !ratesSection || !payTicketButton || !checkTicketButton) {
         console.error("Widget Error: Cannot sync tickets, required DOM elements are missing.");
         // Nothing we can do here regarding display if elements are missing.
         return;
    }

    if (!db || !adminUserId || adminUserId.includes('<!--')) { // Added adminUserId check
         console.warn("Widget: syncTickets called but DB or adminId not ready/invalid.");
         // Ensure UI reflects this state - Show basic info/search, hide sales
         loadingMessage.textContent = 'Service de paiement de tickets indisponible (ID Administrateur ou connexion DB manquante).';
         loadingMessage.style.display = 'block';
         optionsContainer.style.display = 'none'; // Hide sales options
         payTicketButton.style.display = 'none'; // Hide pay button
         ratesSection.style.display = 'block'; // Show title section
         checkTicketButton.style.display = 'block'; // Show search button

         availableTicketsCache = {}; // Clear available tickets
         removeStoredTicketLocally(); // Clear local storage if DB is not ready
         createTicketOptions(availableTicketsCache); // This will show the message set above
         return;
    }

    // console.log("Widget: Starting ticket sync..."); // Avoid excessive logging
    try {
        const isActive = await checkSubscriptionStatus();

        if (!isActive) {
             console.log("Widget: Subscription inactive, hiding ticket options.");
             // Show info/search, hide sales
             loadingMessage.textContent = 'Service de paiement de tickets indisponible. (Abonnement inactif)';
             loadingMessage.style.display = 'block';
             optionsContainer.style.display = 'none'; // Hide sales options
             payTicketButton.style.display = 'none'; // Hide pay button
              ratesSection.style.display = 'block'; // Show title section
              checkTicketButton.style.display = 'block'; // Show search button

             availableTicketsCache = {}; // Clear available tickets if service is inactive
             removeStoredTicketLocally(); // Clear local storage if subscription is inactive
             createTicketOptions(availableTicketsCache); // This will show the message set above
             return;
        }

        // Fetch ONLY TicketsTotal to know which categories and prices exist
        const ticketsTotalRef = ref(db, `users-data/${adminUserId}/TicketsTotal`); // Use adminUserId for path
        const snapshotTotal = await get(ticketsTotalRef);
        const fetchedTotalTickets = snapshotTotal.val() || {};

        // availableTicketsCache now stores the raw fetched data for display purposes only
        availableTicketsCache = fetchedTotalTickets;

        // Render options based on what's currently listed in TicketsTotal
        createTicketOptions(availableTicketsCache);
        // console.log("Widget: Ticket sync complete. Available tickets structure for display:", availableTicketsCache); // Avoid excessive logging

    } catch (error) {
        console.error("Widget Error: Erreur lors de la synchronisation des tickets pour affichage:", error);
        // Show info/search, hide sales, display error message
        loadingMessage.textContent = 'Erreur lors du chargement des types de tickets.';
        loadingMessage.style.display = 'block';
        optionsContainer.style.display = 'none'; // Hide sales options
        payTicketButton.style.display = 'none'; // Hide pay button
         ratesSection.style.display = 'block'; // Show title section
         checkTicketButton.style.display = 'block'; // Show search button

        availableTicketsCache = {}; // Clear available tickets on error
         createTicketOptions(availableTicketsCache); // Update UI to show error message
         removeStoredTicketLocally(); // Clear local storage on sync error
    }
}


// createTicketOptions now uses the raw TicketsTotal data (availableTicketsCache)
function createTicketOptions(ticketsDataForDisplay) {
     // Basic check for DOM elements before trying to manipulate them
    if (!optionsContainer || !loadingMessage || !ratesSection || !payTicketButton || !checkTicketButton) {
         console.error("Widget Error: Cannot create ticket options, required DOM elements are missing.");
         return;
    }
    optionsContainer.innerHTML = ''; // Clear previous options

    const categories = Object.keys(ticketsDataForDisplay);
    let ticketsFoundForDisplay = false; // Flag to see if *any* displayable tickets were found

     // Sort categories alphabetically
     categories.sort();

    for (const category of categories) {
         const data = ticketsDataForDisplay[category];
         // Check if the category has at least one ticket entry with user and price
         // This is just for display - doesn't guarantee actual availability/uniqueness later
         if (data && Array.isArray(data.utilisateur) && data.utilisateur.length > 0 && Array.isArray(data.prix) && data.prix.length > 0) {
             ticketsFoundForDisplay = true; // Mark that we found something to display
             // Use the price of the first *listed* ticket in this category for display
             const price = data.prix[0];
             // Determine button text (e.g., 'Obtenir' for gift/free tickets, 'Payer' otherwise)
             const buttonText = category.toLowerCase().includes('ticket cadeau') || category.toLowerCase().includes('gratuit') ? 'Obtenir' : 'Payer';
             const amount = parseInt(price, 10); // Ensure amount is an integer

             const optionDiv = document.createElement('div');
             optionDiv.className = 'widget-dynamic-ticket-option';

             const textP = document.createElement('p');
             // Use innerHTML for bold/color formatting as in CSS
             // Ensure price is valid before displaying FCFA
             textP.innerHTML = `<font><strong>${escapeHtml(category)}</strong> - ${isNaN(amount) ? 'Prix Inconnu' : `${escapeHtml(price)}F`}</font>`;

             const button = document.createElement('button');
             button.textContent = buttonText;
             button.className = 'widget-dynamic-payment-button';
             // Disable button if price is not a valid number for payment (still allow 'Obtenir' if amount is 0?)
             // Let's disable if amount is NaN or <= 0 for 'Payer', but allow amount = 0 for 'Obtenir'.
             const isFreeCategory = category.toLowerCase().includes('ticket cadeau') || category.toLowerCase().includes('gratuit');
             const isPaidCategoryWithZeroPrice = !isFreeCategory && (isNaN(amount) || amount <= 0);
             const isDisabled = isPaidCategoryWithZeroPrice; // Disable only if paid category has invalid/zero price

             if (isDisabled) {
                  button.disabled = true;
                  button.textContent = 'Indisponible'; // Indicate why it's disabled
                  button.title = "Ce ticket n'est pas disponible à l'achat."; // Add a tooltip for disabled state
             } else {
                 // Use a closure to pass category and amount correctly, and the button element itself
                 button.onclick = (function(cat, amt, btnElement) {
                    return function() {
                         // Disable button immediately to prevent double clicks
                         btnElement.disabled = true;
                         const originalText = btnElement.textContent;
                         btnElement.textContent = 'Traitement...'; // Indicate processing state
                         showLoader(); // Show global loader

                         // Call the main initPayment function with the selected category and determined amount
                         // initPayment handles the rest: duplicate check, reservation, FedaPay, restore/store
                         window.initPayment(cat, amt)
                             .finally(() => {
                                 // Re-enable button after process completes (success or fail), UNLESS it was initially disabled
                                 if (!isDisabled) { // Only re-enable if it wasn't disabled *before* click
                                     btnElement.disabled = false;
                                     btnElement.textContent = originalText;
                                 }
                                 hideLoader(); // Hide global loader
                                 // syncTickets() is called within initPayment's FedaPay callbacks or error handling,
                                 // or after the find/reserve loop finishes.
                                 // A final sync here ensures the UI updates after the whole process.
                                 setTimeout(syncTickets, 500); // Small delay to allow DB write
                             });
                    };
                 })(category, amount, button); // Pass `button` element here
             }


             optionDiv.appendChild(textP);
             optionDiv.appendChild(button);
             optionsContainer.appendChild(optionDiv);
         } else {
              // console.warn(`Widget: Category "${category}" seems empty or malformed in TicketsTotal, skipping display.`); // Avoid excessive logging
         }
    }

    // --- Manage visibility based on whether displayable tickets were found ---
    ratesSection.style.display = 'block'; // Always show the title section if this function is called successfully after DB init
    checkTicketButton.style.display = 'block'; // Always show the search button if this function is called successfully after DB init

    if (ticketsFoundForDisplay) {
         optionsContainer.style.display = 'flex'; // Show options container
         payTicketButton.style.display = 'block'; // Show pay button
         loadingMessage.style.display = 'none'; // Hide loading message if options are shown
         // console.log("Widget: Ticket options displayed."); // Avoid excessive logging
    } else {
         // If no tickets found to display (either no categories, or all categories are empty/malformed)
         const checkStatusAndDisplayMessage = async () => {
             const isActive = await checkSubscriptionStatus(); // Re-check status to be sure
             if (!isActive) {
                 // Message already set in syncTickets, just ensure display state
                 loadingMessage.textContent = 'Service de paiement de tickets indisponible. (Abonnement inactif)';
             } else if (categories.length > 0) {
                  // Categories exist, but all are empty/malformed according to the check above
                  loadingMessage.textContent = 'Aucun ticket disponible à la vente pour le moment dans les catégories configurées.';
             } else {
                  // No categories found in TicketsTotal or sync failed previously
                  loadingMessage.textContent = 'Aucune catégorie de tickets configurée ou erreur de chargement des données.';
             }
              loadingMessage.style.display = 'block'; // Ensure message is visible
              optionsContainer.style.display = 'none'; // Ensure options are hidden
              payTicketButton.style.display = 'none'; // Hide pay button

         };
         // Execute message setting
         checkStatusAndDisplayMessage().catch(err => {
              console.error("Widget Error: Failed to check subscription status for message in createTicketOptions.", err);
              loadingMessage.textContent = 'Erreur lors du chargement des tickets.';
              loadingMessage.style.display = 'block';
              optionsContainer.style.display = 'none';
              payTicketButton.style.display = 'none';
         });
          console.log("Widget: No ticket options found or displayed.");
    }
}

// MODIFIED restoreTicket to use runTransaction for safety and ensure it doesn't add duplicates
async function restoreTicket(category, ticket) {
    if (!db || !adminUserId || adminUserId.includes('<!--') || !ticket || !ticket.user) { // Added adminUserId check
         console.warn("Widget: Cannot restore ticket, DB/adminId not available or ticket data missing/invalid.");
         return;
     }
     console.log(`Widget: Attempting to restore ticket for category: ${category}, user: ${ticket.user} (Admin: ${adminUserId})`); // Include adminId in log
     try {
        const ticketsTotalRef = ref(db, `users-data/${adminUserId}/TicketsTotal/${category}`); // Use adminUserId for path

        // Use transaction for safer restoration
        const result = await runTransaction(ticketsTotalRef, (currentData) => {
             // If the node doesn't exist, initialize it or abort if ticket shouldn't exist here
             // Let's initialize if null, assuming category might have been removed if empty
             const dataToUpdate = currentData || { utilisateur: [], motDePasse: [], prix: [] };

             // Add basic checks for array types just in case
             if (!Array.isArray(dataToUpdate.utilisateur)) dataToUpdate.utilisateur = [];
             if (!Array.isArray(dataToUpdate.motDePasse)) dataToUpdate.motDePasse = [];
             if (!Array.isArray(dataToUpdate.prix)) dataToUpdate.prix = [];


             // Basic check if the ticket already exists to avoid obvious duplicates from race conditions
             // This is not perfect for multiple identical tickets (same user/pass), but reduces simple duplicates.
             // Use 'some' for clarity
             const alreadyExists = dataToUpdate.utilisateur.some((u, i) => {
                 const existingPassword = (dataToUpdate.motDePasse && dataToUpdate.motDePasse.length > i) ? dataToUpdate.motDePasse[i] : '';
                 return u === ticket.user && existingPassword === (ticket.password || '');
             });

             if (alreadyExists) {
                 console.warn(`Widget: Ticket ${ticket.user} for category ${category} already seems to exist in TotalTickets during restore transaction. Aborting restore transaction.`);
                 return undefined; // Abort transaction by returning undefined
             }

             // Add the ticket back to the beginning of the arrays (most recent first)
             dataToUpdate.utilisateur.unshift(ticket.user);
             dataToUpdate.motDePasse.unshift(ticket.password || ''); // Ensure password is added
             dataToUpdate.prix.unshift(ticket.price || 0); // Ensure price is added

             console.log(`Widget: [Transaction] Preparing to restore ticket ${ticket.user}.`);
             return dataToUpdate; // Return updated data to commit transaction
        });

        if (result.committed) {
            console.log(`Widget: Ticket restauré pour la catégorie ${category}: ${ticket.user}.`);
        } else if (result.error) {
             console.error("Widget Error: Restore transaction failed:", result.error);
             // Handle failure: Maybe show a critical error notification? The ticket might be lost.
             showWidgetNotification("Erreur Critique", `Impossible de restaurer le ticket ${ticket.user} (${category}). Contactez l'administrateur.`, false);
        } else {
             // Transaction aborted (likely because ticket already existed based on our check or initial data was null)
             console.log(`Widget: Restore transaction aborted (ticket likely already exists or initial data was null).`);
        }

     } catch (error) {
         console.error("Widget Error: Erreur générale lors de la restauration du ticket:", error);
         showWidgetNotification("Erreur Critique", `Une erreur est survenue lors de la tentative de restauration du ticket ${ticket.user} (${category}). Contactez l'administrateur.`, false);
     }
     // Sync will be handled by the finally block in the button click handler.
}

// Stores a successfully sold ticket in VendorsHistory under a specific vendor key (e.g., "Widget Vente en Ligne")
// This function is called from the FedaPay onComplete callback OR free ticket logic.
async function storeSaleInHistory(vendorName, ticket) {
    if (!db || !adminUserId || adminUserId.includes('<!--') || !vendorName || !ticket || !ticket.user || !ticket.category) { // Added adminUserId check
        console.warn("Widget: Cannot store sale, DB/adminId/vendorName/ticket data missing or invalid.");
        return;
    }
    console.log(`Widget: Storing sale in VendorsHistory (${adminUserId})/${vendorName}:`, ticket.user); // Include adminId in log and path
    try {
       // Store under the specified vendor key within VendorsHistory
       const salesRef = ref(db, `users-data/${adminUserId}/VendorsHistory/${vendorName}`); // Use adminUserId for path
       await push(salesRef, {
           user: ticket.user,
           password: ticket.password || '', // Store password if available
           price: ticket.price || 0, // Store price if available
           category: ticket.category, // Store category name
           soldAt: Date.now(), // Use timestamp
            // Add payment specific details if available (for paid tickets)
           transactionId: ticket.transactionId || null, // FedaPay transaction ID (can be null for free)
           paymentStatus: ticket.paymentStatus || 'completed', // FedaPay status (can be 'free')
            transactionUserId: ticket.transactionUserId || null // Internal generated ID (can be null for free)
       });
       console.log(`Widget: Sale stored successfully under "${vendorName}" for admin ${adminUserId}.`);
   } catch (error) {
       console.error(`Widget Error: Erreur lors du stockage de la vente sous "${vendorName}":`, error);
       // Do not show user notification for this internal error, log it.
   }
}

// Stores a successfully sold ticket in BalanceSales
// Called for BOTH paid and free tickets
async function storeBalanceSale(ticket) {
    if (!db || !adminUserId || adminUserId.includes('<!--') || !ticket || ticket.price == null || !ticket.user) { // Added adminUserId check and price check
        console.warn("Widget: Cannot store balance sale, DB/adminId/data missing or incomplete/invalid.", ticket);
        return;
    }
    console.log(`Widget: Storing sale in BalanceSales (${adminUserId}) for user ${ticket.user}, amount ${ticket.price}, vendor ${ticket.vendor || 'Unknown'}`); // Include adminId in log and path
    try {
        const balanceSalesRef = ref(db, `users-data/${adminUserId}/BalanceSales`); // Use adminUserId for path
        const newSale = {
            user: ticket.user,
            password: ticket.password || '',
            price: parseFloat(ticket.price) || 0, // Stocke le prix numérique
            category: ticket.category || 'Unknown',
            vendor: ticket.vendor || 'Unknown', // Should be populated by initPayment
            soldAt: Date.now(), // Timestamp de l'opération
            status: ticket.paymentStatus || 'approved', // Use paymentStatus (e.g., 'free', 'completed', 'pending', etc.)
             // Add payment specific details if available (for paid tickets)
            transactionId: ticket.transactionId || null, // FedaPay transaction ID (can be null for free)
            transactionUserId: ticket.transactionUserId || null // Internal generated ID (can be null for free)
        };
        await push(balanceSalesRef, newSale);
        console.log(`Widget: Balance sale stored successfully in BalanceSales (${adminUserId}).`);
    } catch (error) {
        console.error(`Widget Error: Failed to store balance sale:`, error);
        // Do not show user notification for this internal error, log it.
    }
}

// Stores a successfully sold ticket in TicketsVendus (Global history)
// Called for BOTH paid and free tickets
async function storeTicketVendu(ticket) {
     if (!db || !adminUserId || adminUserId.includes('<!--') || !ticket || !ticket.user || !ticket.category || ticket.price == null) { // Added adminUserId check and price check
         console.warn("Widget: Cannot store sold ticket globally (TicketsVendus), DB/adminId/data missing or invalid.");
         return;
     }
     console.log("Widget: Storing sold ticket in global history (TicketsVendus):", ticket.user);
     try {
        const ticketsVendusRef = ref(db, `users-data/${adminUserId}/TicketsVendus`); // Use adminUserId for path
        const newSale = {
            user: ticket.user,
            password: ticket.password || '',
            price: parseFloat(ticket.price) || 0,
            category: ticket.category,
            timestamp: new Date().toISOString(), // Keep ISO string for human readability
            soldAt: Date.now(), // Use timestamp for sorting/queries
            vendor: ticket.vendor || 'Unknown', // Include the vendor
             // Add payment specific details if available (for paid tickets)
            transactionId: ticket.transactionId || null, // FedaPay transaction ID (can be null for free)
            paymentStatus: ticket.paymentStatus || 'completed', // FedaPay status (can be 'free')
            transactionUserId: ticket.transactionUserId || null // Internal generated ID (can be null for free)
        };
        await push(ticketsVendusRef, newSale);
        console.log("Widget: Ticket vendu stocké avec succès dans Firebase (TicketsVendus).");
    } catch (error) {
        console.error("Widget Error: Erreur lors du stockage du ticket vendu (TicketsVendus):", error);
        // Do not show user notification for this internal error, log it.
    }
}


// Stores a ticket locally in localStorage after purchase/obtainment
function storeTicketLocally(ticketData) {
    try {
        // Store only relevant info. User and password are needed for the 'Connexion' button.
         // Include category and price as well for display in notification
        localStorage.setItem('storedTicket', JSON.stringify({
             user: ticketData.user,
             password: ticketData.password,
             category: ticketData.category, // Store category name
             price: ticketData.price // Store price for display
        }));
         console.log("Widget: Ticket stored locally for user:", ticketData.user);
    } catch (e) {
         console.error("Widget Error: Erreur lors du stockage local du ticket:", e);
         console.warn("Widget: Unable to store ticket locally. User won't see 'Voir mon ticket'.");
    } finally {
         updateButtonText(); // Update the main button text after potentially storing a ticket
    }
}

// Removes the locally stored ticket
function removeStoredTicketLocally() {
     try {
        localStorage.removeItem('storedTicket');
        console.log("Widget: Local ticket removed.");
     } catch (e) {
        console.error("Widget Error: Erreur lors de la suppression locale du ticket:", e);
     } finally {
         updateButtonText(); // Update the main button text after removing the ticket
     }
}


 // Checks if a free ticket can be obtained based on localStorage timestamp
 function canGetFreeTicket() {
    const lastFreeTicket = localStorage.getItem('lastFreeTicket');
    if (!lastFreeTicket) return true; // No record means they can get one

    // Ensure parsing as integer (base 10)
    const lastTicketTimestamp = parseInt(lastFreeTicket, 10);
    if (isNaN(lastTicketTimestamp)) {
        console.warn("Widget: Invalid lastFreeTicket timestamp found, clearing.", lastFreeTicket);
        localStorage.removeItem('lastFreeTicket'); // Clear invalid entry
        return true; // Allow if data is invalid
    }

    const lastTicketDate = new Date(lastTicketTimestamp);
    const now = new Date();
    const diffTime = now.getTime() - lastTicketDate.getTime(); // Use getTime() for reliable diff
    const diffDays = diffTime / (1000 * 60 * 60 * 24); // Difference in days

    const allowed = diffDays >= 7; // Check if 7 or more full days have passed
    console.log(`Widget: Checking free ticket eligibility. Last ticket timestamp: ${lastTicketTimestamp} (${new Date(lastTicketTimestamp).toISOString()}), now: ${now.toISOString()}. Diff days: ${diffDays.toFixed(2)}. Allowed (>=7 days): ${allowed}`); // Format timestamp in log
    return allowed;
}

// Sets the timestamp for the last free ticket obtained
function setLastFreeTicketTimestamp() {
     try {
        localStorage.setItem('lastFreeTicket', Date.now().toString());
        console.log("Widget: Last free ticket timestamp updated.");
     } catch (e) {
         console.error("Widget Error: Erreur lors du stockage du timestamp du ticket gratuit:", e);
     }
}

// --- Store connected ticket username in Firebase ---
// This is called BEFORE attempting auto-login from the widget notification.
// Kept this function even if not called by default UI, might be useful in custom implementations.
async function storeConnectedTicket(username) {
    if (!db || !adminUserId || adminUserId.includes('<!--') || !username) { // Added adminUserId check
         console.warn("Widget: Cannot store connected ticket, DB/adminId not available or username missing/invalid.");
         return;
     }
     console.log(`Widget: Attempting to store connected ticket username: ${username} (Admin: ${adminUserId})`); // Include adminId in log
     try {
        // This path is consistent with login.html's storage of connected users
        const ticketConnectedRef = ref(db, `users-data/${adminUserId}/TicketConnecté`); // Use adminUserId for path
        // Use push to create a unique key for each connection attempt
        const newTicketRef = push(ticketConnectedRef);
        // Use timestamp instead of ISO string here for consistency maybe? Or keep ISO string. Let's keep ISO string for consistency with old code.
         await set(newTicketRef, { username: username, timestamp: new Date().toISOString() }); // Keep ISO string
        console.log("Widget: Connected ticket username enregistré dans Firebase avec la clé:", newTicketRef.key);
    } catch (error) {
        console.error("Widget Error: Erreur lors de l'enregistrement du nom d'utilisateur du ticket connecté:", error);
    }
}


// --- MODIFIED initPayment for duplicate check and transaction-based reservation ---
window.initPayment = async function(category, amount) {
    console.log(`Widget: initPayment called for category: "${category}", amount: ${amount}`);

    // Basic checks - CRITICAL ERRORS preventing payment flow
     if (!adminUserId || adminUserId.includes('<!--')) { // Added check for valid adminUserId
         hideLoader(); // Ensure loader is hidden
         showWidgetNotification("Erreur Configuration", "ID Administrateur manquant ou invalide. Contactez l'administrateur.", false);
         console.error("Widget Critical Error: Admin User ID is missing or invalid.");
         return;
    }
    if (typeof FedaPay === 'undefined' || !FedaPay.init) {
        hideLoader(); // Ensure loader is hidden
        showWidgetNotification("Erreur", "Le service de paiement (FedaPay) n'est pas chargé. Vérifiez votre connexion.", false);
        console.error("Widget Critical Error: FedaPay SDK not available.");
        return;
    }
    if (!fedapayApiKey || fedapayApiKey.includes('<!--') || fedapayApiKey === 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY') { // Check against injected config, not just placeholder
        hideLoader(); // Ensure loader is hidden
        showWidgetNotification("Erreur de configuration", "La clé API FedaPay est manquante ou invalide. Contactez l'administrateur.", false);
        console.error("Widget Critical Error: FedaPay API key is missing or default.");
        return;
    }
     if (!db || !runTransaction) { // Ensure DB and runTransaction are available
         hideLoader(); // Ensure loader is hidden
         showWidgetNotification("Erreur", "Connexion à la base de données non établie ou composants manquants.", false);
         console.error("Widget Critical Error: Firebase DB or runTransaction not initialized.");
         return;
     }


    showLoader(); // Show loader at the beginning

    let reservedTicketData = null; // This will hold the specific ticket {user, password, price, category, vendor} found and reserved
    let findAttempt = 0;
    let findSuccessful = false;
    const ticketsTotalCategoryRef = ref(db, `users-data/${adminUserId}/TicketsTotal/${category}`); // Use adminUserId for path

    // --- Handle Free Tickets Eligibility First (before reservation loop) ---
    const isFreeCategory = category.toLowerCase().includes('ticket cadeau') || category.toLowerCase().includes('gratuit');
    const vendorId = isFreeCategory ? "Produit offert" : "Vente hors réseau"; // Determine vendor name early

    if (isFreeCategory) {
         console.log("Widget: Checking free ticket eligibility for category:", category);
         if (!canGetFreeTicket()) {
             hideLoader();
             showWidgetNotification("Non disponible", "Vous avez déjà obtenu un ticket cadeau récemment. Attendez 7 jours avant de pouvoir en obtenir un autre.", false);
             console.log("Widget: Free ticket eligibility failed.");
             // No reservation occurred, so no need to restore.
             // Sync tickets will be called by the button's finally block.
             return; // Abort process if not eligible
         }
         console.log("Widget: Free ticket eligibility passed. Attempting to reserve free ticket.");

        // Use transaction to atomically reserve the first available ticket for a free category
        let candidateTicketDetails = null; // Will hold the ticket details if successfully reserved
        const transactionResult = await runTransaction(ticketsTotalCategoryRef, (currentDataInTx) => {
           console.log("Widget: [Transaction] Attempting to reserve free ticket...");
           if (!currentDataInTx || !Array.isArray(currentDataInTx.utilisateur) || currentDataInTx.utilisateur.length === 0) {
               console.log("Widget: [Transaction] No tickets left in category during free ticket transaction.");
               return null; // Abort transaction, no tickets left
           }

           // Get details of the *first* ticket in the *current state within the transaction*
           const user = currentDataInTx.utilisateur[0];
           const password = (currentDataInTx.motDePasse && currentDataInTx.motDePasse.length > 0) ? (currentDataInTx.motDePasse[0] || '') : '';
           const price = (currentDataInTx.prix && currentDataInTx.prix.length > 0) ? (currentDataInTx.prix[0] || 0) : 0; // Price might be 0 or something else for free tickets

           // Capture the ticket details BEFORE modifying the state for transaction
           candidateTicketDetails = { user, password, price, category, vendor: vendorId };

           // Prepare updated data (remove the first ticket)
           const updatedData = {
               ...currentDataInTx, // Copy existing properties
               utilisateur: currentDataInTx.utilisateur.slice(1), // Remove the first user
               motDePasse: currentDataInTx.motDePasse ? currentDataInTx.motDePasse.slice(1) : [], // Remove corresponding password
               prix: currentDataInTx.prix ? currentDataInTx.prix.slice(1) : [] // Remove corresponding price
           };

            // If removing the last ticket, return null to remove the category node
           if (updatedData.utilisateur.length === 0) {
                console.log(`Widget: [Transaction] Category "${category}" is now empty, preparing to remove node.`);
                return null; // Remove the node
           }

           // Return the updated data to commit the removal
           console.log(`Widget: [Transaction] Reserved free ticket ${user}. Preparing to commit.`);
           return updatedData;

        }); // --- End of runTransaction callback for Free Ticket ---

        hideLoader(); // Hide loader after transaction attempt for free ticket

        // Analyze transaction result for Free Ticket
        if (transactionResult.committed && candidateTicketDetails) {
            // Ticket successfully reserved (removed from stock)
            reservedTicketData = candidateTicketDetails; // Store the reserved ticket details
            console.log("Widget: Free ticket successfully reserved:", reservedTicketData.user);

             // Mark the timestamp of the last free ticket obtained locally
            setLastFreeTicketTimestamp();

            // --- Stockage des données de vente pour les tickets cadeau ---
            // Utiliser les fonctions de stockage partagées, elles incluront le vendor "Widget Vente en Ligne (Gratuit)"
            // Note: For free tickets, transactionId and transactionUserId might be null/undefined.
             const freeTicketDetails = { ...reservedTicketData, transactionId: null, paymentStatus: 'free', transactionUserId: null };
            await storeBalanceSale(freeTicketDetails); // Stocker dans BalanceSales (avec prix=0)
            await storeSaleInHistory(freeTicketDetails.vendor, freeTicketDetails); // Stocker dans VendorsHistory sous le nom du vendor (Gratuit)
            await storeTicketVendu(freeTicketDetails); // Stocker dans TicketsVendus (global)
            // --- Fin du stockage des données ---

            // Stocker le ticket localement dans le navigateur de l'utilisateur
            storeTicketLocally(reservedTicketData); // Store reservedTicketData, as it contains user/pass/category/price

            // Afficher la notification de succès avec les détails du ticket
            showWidgetNotification("Ticket cadeau obtenu", "Félicitations ! Votre ticket est prêt.", true, reservedTicketData); // Pass reservedTicketData for display

         } else if (!transactionResult.committed && transactionResult.snapshot && transactionResult.snapshot.exists()) { // Check if snapshot exists and transaction didn't commit
            // Transaction aborted (ticket taken by someone else) or failed for other reasons but node exists
            console.warn("Widget: Free ticket transaction aborted (ticket taken?). Syncing UI.");
             showWidgetNotification("Indisponible", "Ce ticket cadeau vient d'être pris. Liste mise à jour.", false);
             // syncTickets() is called in the button's finally block after initPayment finishes.
             // We don't need a specific syncTickets() call here.
         }
        else if (transactionResult.error) {
           console.error("Widget Error: Transaction failed for free ticket:", transactionResult.error);
           showWidgetNotification("Erreur Système", "Erreur lors de la transaction du ticket cadeau. Réessayez.", false);
        } else {
             // Transaction committed successfully but candidateTicketDetails is null (means category was empty initially)
             // Or transaction aborted and snapshot did *not* exist (category was empty)
             console.log("Widget: No tickets found for free category during transaction.");
              showWidgetNotification("Indisponible", `Aucun ticket disponible pour "${category}" pour le moment.`, false);
        }
        // syncTickets() est appelé dans le bloc finally de l'événement click du bouton
        return; // Exit initPayment function for free tickets
    }
    // --- End Handle Free Tickets ---


    // --- Paid Ticket Logic (Reservation + FedaPay) ---

    // --- Find and Reserve a Non-Duplicate Ticket using Transaction ---
    while (findAttempt < MAX_SALE_RESERVATION_ATTEMPTS && !findSuccessful) {
        findAttempt++;
        console.log(`Widget: Attempt ${findAttempt}/${MAX_SALE_RESERVATION_ATTEMPTS} to find and reserve unique ticket for category: "${category}" (Admin: ${adminUserId})`);
        if (findAttempt > 1) {
             // Add a small delay before retrying transaction after a failed attempt (duplicate found and removed or transaction aborted)
             await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
             console.log("Widget: Retrying reservation transaction...");
        }

        // 1. Get current state of TotalTickets for the category (using a simple get before transaction)
        // This snapshot gives us the ticket details *to check*, but the transaction guarantees atomic removal.
        let currentTicketsDataSnapshot;
        try {
            currentTicketsDataSnapshot = await get(ticketsTotalCategoryRef); // Use adminUserId for path
        } catch (dbError) {
             hideLoader();
             console.error(`Widget Error: Failed to get TotalTickets before transaction (attempt ${findAttempt}) for admin ${adminUserId}:`, dbError);
             showWidgetNotification("Erreur Base de Données", "Erreur de lecture du stock avant réservation.", false);
             // Sync tickets will be called by the button's finally block.
             return; // Stop on critical DB error before transaction loop
        }


        const currentTicketsData = currentTicketsDataSnapshot.val();

        if (!currentTicketsData || !Array.isArray(currentTicketsData.utilisateur) || currentTicketsData.utilisateur.length === 0) {
            console.log(`Widget: No more tickets in category "${category}" for admin ${adminUserId} during search (attempt ${findAttempt}).`);
            break; // Exit find loop: no tickets left
        }

        // Get details of the *first* ticket in this current snapshot state
        const candidateUser = currentTicketsData.utilisateur[0];
        // Handle potential missing arrays/elements safely
        const candidatePassword = (currentTicketsData.motDePasse && currentTicketsData.motDePasse.length > 0) ? (currentTicketsData.motDePasse[0] || '') : '';
        const candidatePrice = (currentTicketsData.prix && currentTicketsData.prix.length > 0) ? (currentTicketsData.prix[0] || 0) : 0;

        const candidateTicketDetails = {
            user: candidateUser,
            password: candidatePassword,
            price: candidatePrice,
            category: category,
            vendor: vendorId // Add vendor info now
        };

        // 2. Check if this specific ticket (user/password) is already in our sold history (LIVE CHECK per attempt)
        const isDuplicate = await checkIfTicketSoldInAnyHistory(candidateTicketDetails); // This function uses adminUserId internally

        if (isDuplicate) {
             console.warn(`Widget: Candidate ticket ${candidateUser} found in VendorsHistory. Attempting to remove duplicate from TotalTickets.`);
             // If it's a duplicate, the transaction below will just remove it, and the loop will continue.
        } else {
             console.log(`Widget: Candidate ticket ${candidateUser} appears unique. Attempting to reserve via transaction.`);
             // If it's not a duplicate, the transaction below will remove it, and we'll exit the loop if successful.
        }


        // 3. Use a transaction to atomically remove the *first* ticket, guarding against concurrent changes
        const transactionResult = await runTransaction(ticketsTotalCategoryRef, (currentDataInTx) => {
            // This function is executed inside the transaction
            if (!currentDataInTx || !Array.isArray(currentDataInTx.utilisateur) || currentDataInTx.utilisateur.length === 0) {
                console.warn(`Widget: [Transaction] No tickets left in category "${category}" during transaction execution.`);
                return null; // Abort transaction, no tickets left
            }

            // Get details of the *first* ticket in the *current state within the transaction*
            const currentTxUser = currentDataInTx.utilisateur[0];
            const currentTxPassword = (currentDataInTx.motDePasse && currentDataInTx.motDePasse.length > 0) ? (currentDataInTx.motDePasse[0] || '') : '';
            const currentTxPrice = (currentDataInTx.prix && currentDataInTx.prix.length > 0) ? (currentDataInTx.prix[0] || 0) : 0; // Get price from TX state too

            const ticketInTx = {
                 user: currentTxUser,
                 password: currentTxPassword,
                 price: currentTxPrice, // Include price in the comparison object
                 category: category, // Add category
                 vendor: vendorId // Add vendor
             };


            // **Crucial Check**: Does the *first* ticket currently in the list match the candidate we checked *before* the transaction started?
            // This guards against another client taking the ticket or adding/removing items just before this transaction runs.
            // We compare based on user and password as the unique identifier.
            if (ticketInTx.user === candidateTicketDetails.user && ticketInTx.password === candidateTicketDetails.password) {
                 console.log(`Widget: [Transaction] First ticket (${ticketInTx.user}) matches candidate. Removing it.`);
                 // If it matches, remove this ticket from the arrays
                 const updatedData = {
                     ...currentDataInTx, // Copy existing properties
                     utilisateur: currentDataInTx.utilisateur.slice(1), // Remove the first user
                     motDePasse: currentDataInTx.motDePasse ? currentDataInTx.motDePasse.slice(1) : [], // Remove corresponding password
                     prix: currentDataInTx.prix ? currentDataInTx.prix.slice(1) : [] // Remove corresponding price
                 };

                 // If removing the last ticket, return null to remove the category node
                 if (updatedData.utilisateur.length === 0) {
                      console.log(`Widget: [Transaction] Category "${category}" is now empty, preparing to remove node.`);
                      return null; // Remove the node
                 }

                 // Return the updated data to commit the removal
                 return updatedData;

            } else {
                // The first ticket in the list changed between our initial 'get' and the transaction running.
                // This indicates concurrent activity. Abort this transaction attempt.
                console.warn(`Widget: [Transaction] First ticket in list (${ticketInTx.user}) does NOT match candidate (${candidateTicketDetails.user}). Aborting transaction.`);
                return undefined; // Abort transaction
            }
        }); // --- End of runTransaction callback ---

        // --- Analyze Transaction Result ---
        if (transactionResult.committed) {
            // Transaction committed successfully (either duplicate removed, or unique ticket reserved)
            console.log(`Widget: Transaction committed successfully.`);
            if (!isDuplicate) {
                // We successfully removed a non-duplicate ticket
                reservedTicketData = candidateTicketDetails; // This is the ticket we reserved
                findSuccessful = true; // Mark success to exit the loop
                console.log(`Widget: Unique ticket reserved via transaction: ${reservedTicketData.user}`);
            } else {
                 // We successfully removed a duplicate ticket. Loop will continue to find the next one.
                 console.log(`Widget: Duplicate ticket removed via transaction. Looping to check next ticket.`);
                 // No need to syncTickets here, the next loop iteration's initial 'get' will reflect the change.
            }

        } else if (transactionResult.error) {
            // Transaction failed (e.g., network error, permissions)
             console.error("Widget Error: Transaction failed:", transactionResult.error);
             // The loop will continue if attempts < MAX_SALE_RESERVATION_ATTEMPTS
        } else {
             // Transaction aborted (likely because the first ticket changed)
             console.warn("Widget: Transaction aborted (first ticket changed concurrently?). Retrying...");
             // The loop will continue if attempts < MAX_SALE_RESERVATION_ATTEMPTS
        }

         // Check if we should continue looping
         if (!findSuccessful && findAttempt >= MAX_SALE_RESERVATION_ATTEMPTS) {
              console.warn(`Widget: Max reservation attempts (${MAX_SALE_RESERVATION_ATTEMPTS}) reached without finding and reserving a unique ticket.`);
              break; // Exit loop
         }

    } // --- End of while loop for finding/reserving ticket ---

    hideLoader(); // Hide loader after reservation attempt loop

    // --- Check if a ticket was successfully reserved ---
    if (!reservedTicketData) {
        // If the loop finished but no ticket was reserved
        const msg = findAttempt >= MAX_SALE_RESERVATION_ATTEMPTS
            ? `Impossible de trouver un ticket unique pour la catégorie ${category} après plusieurs tentatives. Contactez l'administrateur.`
            : `Désolé, aucun ticket disponible à la vente pour la catégorie : ${category}.`;
         showWidgetNotification(findAttempt >= MAX_SALE_RESERVATION_ATTEMPTS ? "Erreur Stock" : "Indisponible", msg, false);
         // syncTickets() is called by the button's finally block.
        return; // Stop the payment process
    }

    // --- NOUVEAU : Générer l'ID unique et stocker TOUTES les données du ticket avant FedaPay ---
    // Cet ID sera utilisé dans la description de transaction FedaPay pour faire le lien.
     let transactionUserId = null; // Variable pour stocker l'ID généré
     try {
          console.log(`Widget: Generating unique ID and storing ticket details (${reservedTicketData.user}) in TransactionUserMap...`);
          const userMapRef = ref(db, `users-data/${adminUserId}/TransactionUserMap`); // Référence au nœud de mappage pour cet admin
          const newUserMapRef = push(userMapRef); // Créer une nouvelle clé unique pour cet enregistrement
          transactionUserId = newUserMapRef.key; // Obtenir la clé unique générée
          // Stocker l'intégralité de l'objet reservedTicketData plus un timestamp
          await set(newUserMapRef, {
              ...reservedTicketData, // Étaler toutes les propriétés de reservedTicketData (user, password, price, category, vendor)
              timestamp: Date.now() // Ajouter le timestamp
          });
          console.log(`Widget: Unique ID generated: ${transactionUserId}. Full ticket details stored under this ID.`);

     } catch (error) {
          console.error("Widget Error: Failed to create unique ID entry and store ticket details in TransactionUserMap:", error);
          hideLoader(); // Assurer que le loader est caché sur erreur
          showWidgetNotification("Erreur Système", "Erreur lors de la préparation de la transaction. Le ticket sera restauré. Réessayez.", false);
          // CRITIQUE : Si on ne parvient pas à créer le mappage ID, on NE PEUT PAS continuer avec le paiement,
          // car on ne saura pas à quel utilisateur le paiement était destiné.
          // Restaurer le ticket que l'on vient de réserver.
          await restoreTicket(category, reservedTicketData);
          // syncTickets() est appelé dans le bloc finally de l'événement click du bouton
          return; // Avorter le processus de paiement
     }
    // --- Fin NOUVEAU ---


    // --- Proceed with FedaPay for Paid Tickets now that a ticket is reserved and ID mapped ---
    console.log("Widget: Proceeding with FedaPay payment for reserved ticket:", reservedTicketData.user, "Category:", reservedTicketData.category, "Price:", reservedTicketData.price, "Vendor:", reservedTicketData.vendor);


    // Use the generated unique ID as the description - MODIFIED description format
    const description = `${transactionUserId}`; // Format: just the internal unique ID

    // Use the amount from the button click for payment amount.
    const paymentAmount = amount; // Or use reservedTicketData.price if DB price is authoritative

     if (paymentAmount == null || isNaN(paymentAmount) || paymentAmount <= 0) {
         hideLoader(); // Ensure loader is hidden if amount is invalid
         console.error(`Widget Error: Invalid FedaPay amount (${paymentAmount}) for payment.`);
         showWidgetNotification("Erreur Paiement", "Montant invalide pour le paiement.", false);
         // Need to restore the ticket as we cannot proceed with payment
         await restoreTicket(category, reservedTicketData);
         // Note: The TransactionUserMap entry remains. This is acceptable as it logs the attempt.
         // syncTickets() is called by the button's finally block.
         return;
     }

    const fedaPayInstance = FedaPay.init({
        public_key: fedapayApiKey,
        transaction: { amount: paymentAmount, description: description, currency: { code: 'XOF' } }, // Use the generated ID in the description
         customer: { email: 'placeholder@example.com' }, // Placeholder email
        onComplete: async (response) => {
            console.log("Widget: FedaPay onComplete:", response);
            // reservedTicketData and transactionUserId are accessible here via closure

            hideLoader(); // Hide loader once FedaPay flow is complete

            if (response.reason === FedaPay.DIALOG_DISMISSED) {
                showWidgetNotification("Paiement annulé", "Le processus de paiement a été annulé.", false);
                console.log("Widget: Payment cancelled by user. Restoring ticket...");
                 // Restore ticket if payment is cancelled
                if (reservedTicketData) { // Double check ticket data exists
                    await restoreTicket(category, reservedTicketData); // Pass the specific reserved ticket
                    // Note: The TransactionUserMap entry remains. This is acceptable.
                }


            } else if (response.reason === FedaPay.CHECKOUT_COMPLETED) {
                // Add FedaPay details to the ticket object for storage
                const soldTicketDetails = {
                    ...reservedTicketData, // Contains user, pass, price, category, vendor
                    transactionId: response.transaction.id, // FedaPay transaction ID
                    paymentStatus: response.status, // FedaPay payment status
                    transactionUserId: transactionUserId // Include the generated ID in the sale record
                    // Add other relevant response fields if needed (e.g., transaction_key if available in response)
                };
                showWidgetNotification("Paiement réussi", `Merci pour votre achat ! Votre ticket est prêt.`, true, soldTicketDetails);
                 console.log("Widget: Payment successful. Storing sale...");
                 // Store in all relevant locations
                 await storeBalanceSale(soldTicketDetails); // Stocker dans BalanceSales
                 await storeSaleInHistory(soldTicketDetails.vendor, soldTicketDetails); // Stocker dans VendorsHistory (Payant)
                 await storeTicketVendu(soldTicketDetails); // Stocker dans TicketsVendus (global)

                 // Store ticket locally for "Voir mon ticket"
                 storeTicketLocally(soldTicketDetails);
                 console.log("Widget: Ticket stored successfully after payment.");

            } else {
                // Payment attempted but not approved or other status
                // FedaPay statuses might include PENDING, FAILED, etc.
                console.warn(`Widget: Payment status is neither DIALOG_DISMISSED nor CHECKOUT_COMPLETED via onComplete: ${response.status || 'unknown'}. Transaction ID: ${response.transaction?.id || 'N/A'}.`);
                showWidgetNotification("Paiement non confirmé", `Statut: ${response.status || 'inconnu'}. Ticket non délivré. Si vous pensez avoir été débité, contactez le support.`, false);
                // Restore the ticket in case of ambiguous or failed statuses where we didn't get PAID
                if (reservedTicketData) { // Double check ticket data exists
                     await restoreTicket(category, reservedTicketData); // Pass the specific reserved ticket
                     // Optionally, log the transaction in TicketsVendus/BalanceSales with the specific status
                     // await storeTicketVendu({...reservedTicketData, paymentStatus: response.status || 'unknown', transactionId: response.transaction?.id || null, transactionUserId: transactionUserId});
                     // await storeBalanceSale({...reservedTicketData, paymentStatus: response.status || 'unknown', transactionId: response.transaction?.id || null, transactionUserId: transactionUserId});
                } else {
                   console.error("Widget Error: Non-COMPLETED/DISMISSED status received but no reserved ticket data found!");
                }
            }
             // syncTickets() is called in the button's finally block.

        }, // --- End of onComplete ---

         onError: async (error) => {
              console.error("Widget: FedaPay onError:", error);
              hideLoader(); // Ensure loader is hidden on error
              let errorMessage = "Une erreur FedaPay est survenue.";
               if (error && error.message) {
                   errorMessage = `Erreur FedaPay: ${error.message}`;
               } else if (typeof error === 'string') {
                   errorMessage = `Erreur FedaPay: ${error}`;
               }
              showWidgetNotification("Erreur Paiement", errorMessage, false);
             // Restore ticket on FedaPay API error
              if (reservedTicketData) { // Double check ticket data exists
                 await restoreTicket(category, reservedTicketData); // Pass the specific reserved ticket
                  // Optionally, log the failed transaction in TicketsVendus/BalanceSales with status 'error'
                  // await storeTicketVendu({...reservedTicketData, paymentStatus: 'error', transactionId: null, transactionUserId: transactionUserId}); // No FedaPay ID on error
                  // await storeBalanceSale({...reservedTicketData, paymentStatus: 'error', transactionId: null, transactionUserId: transactionUserId}); // Maybe not needed for balance on error
              } else {
                 console.error("Widget Error: onError received but no reserved ticket data found!");
              }
             // syncTickets() is called in the button's finally block.
          } // --- End of onError ---
    }); // --- End of FedaPay.init ---

    try {
         // showLoader("Ouverture du portail de paiement..."); // No loader text update in payer-style
        fedaPayInstance.open();
    } catch (openError) {
        console.error("Widget Error: Failed to open FedaPay dialog:", openError);
         hideLoader(); // Hide loader if opening fails
        showWidgetNotification("Erreur de paiement", `Impossible d'ouvrir la fenêtre de paiement: ${openError.message}.`, false);
        // If opening fails *after* reservation and TransactionUserMap entry creation, restore the ticket
        if (reservedTicketData) { // Double check ticket data exists
             await restoreTicket(category, reservedTicketData);
             // Note: The TransactionUserMap entry remains.
        }
         // syncTickets() is called by the button's finally block.
    }


    // No finally block here for syncTickets because it's handled by the FedaPay callbacks (onComplete/onError)
    // or explicitly called after errors occurring before FedaPay init or by the button click handler's finally.
}; // --- End of initPayment ---


// --- Auto-Login Function (Replicating login.html behaviour) ---
// This function assumes the host page is login.html and has a form with name="login"
// containing username and password inputs. It's kept and now used by the notification popup.
// NOTE: This function is now NOT triggered by the notification buttons in this version.
window.autoLogin = function(username, password) {
    console.log(`Widget: Attempting auto-login for ${username} by filling existing form...`);

    const loginForm = document.querySelector('form[name="login"]');

    if (!loginForm) {
        console.error("Widget Error: Could not find the main login form (form[name='login']) on the page. Auto-login failed.");
        showWidgetNotification("Erreur de Connexion", "Impossible de trouver le formulaire de connexion sur la page.", false);
        return;
    }

    try {
        // Find the username and password input fields within the form
        // Use .elements to safely access form controls by name
        const usernameInput = loginForm.elements['username'];
        const passwordInput = loginForm.elements['password'];

         // Check if required fields are found (at least username is essential)
         if (!usernameInput) {
            console.error("Widget Error: Could not find username input field within the found login form. Auto-login failed.");
            showWidgetNotification("Erreur Connexion Auto", "Champ 'username' manquant dans le formulaire.", false);
            return;
        }


        // Fill the input fields with the provided username and password
        usernameInput.value = username;
         // Only attempt to set password if the field exists and a password is provided
         if (passwordInput && password) {
             passwordInput.value = password;
         } else if (passwordInput && !password) {
             // If password field exists but no password provided, clear it.
             passwordInput.value = '';
         }
         // If passwordInput doesn't exist, it's likely 'same' mode, no password needed.


        console.log(`Widget: Filled login form for ${username}. Submitting...`); // Log username, avoid logging password


        // Trigger the form submission.
        // IMPORTANT: If your login form uses MD5 hashing (like the original login.html sample),
        // you need to call the doLogin() function here *instead* of form.submit().
        // doLogin() is responsible for calculating the challenge/response and submitting the form with MD5.
        // This requires the Mikrotik $(chap-id) and $(chap-challenge) variables to be present
        // in the HTML and the hexMD5 function available.

        if (typeof doLogin === 'function') {
            console.log("Widget: doLogin() function found. Using doLogin() for submission.");
            doLogin(); // Use the Mikrotik hashing function if available
        } else {
            console.log("Widget: doLogin() function not found. Using form.submit().");
            // Fallback to direct form submission (might not work if MD5 is required)
            loginForm.submit();
        }


    } catch (error) {
        console.error("Widget Error: An unexpected error occurred while attempting to fill or submit the existing login form.", error);
         showWidgetNotification("Erreur système", "Une erreur interne est survenue lors de la connexion automatique.", false);
    }
}


// --- NEW: Search Modal Functions ---

// Show the search modal
function showSearchModal() {
    if (!searchModal) {
        console.error("Widget Error: Search modal element not found.");
        showWidgetNotification("Erreur", "Erreur interne du widget. Veuillez rafraîchir.", false);
        return;
    }
     // Clear previous state
     searchInput.value = '';
     displaySearchMessage('', 'info'); // Clear previous messages
     searchLoader.style.display = 'none';
     searchButton.disabled = false;

    searchModal.style.display = 'block';
    // Optional: Automatically focus the input
    setTimeout(() => searchInput.focus(), 100);
    console.log("Widget: Search modal shown.");
}

// Hide the search modal
function hideSearchModal() {
    if (searchModal) {
        searchModal.style.display = 'none';
         console.log("Widget: Search modal hidden.");
    }
}

// Helper to display messages in the search modal
function displaySearchMessage(message, type = 'info') {
    if (searchMessage) {
        searchMessage.textContent = message;
        // Use a class for styling (see fedapay-widget.css)
        searchMessage.className = `widget-search-message ${type}`;
    }
}

// Handle the search button click - NEW CORE LOGIC
async function handleSearchTicket() {
    const transactionKey = searchInput.value.trim();

    if (!transactionKey) {
        displaySearchMessage("Veuillez entrer la clé de transaction.", 'error');
        return;
    }

    // Clear previous message and show loader
    displaySearchMessage('', 'info');
    searchLoader.style.display = 'block';
    searchButton.disabled = true;


    if (!db || !adminUserId || adminUserId.includes('<!--')) {
        displaySearchMessage("Erreur système: Configuration widget incomplète (DB/Admin ID).", 'error');
        console.error("Widget Error: DB or Admin ID missing for search.");
        searchLoader.style.display = 'none';
        searchButton.disabled = false;
        return;
    }

     // Fetch the Private API Key before searching FedaPay
     // If it was already fetched during init, use the cached value
     if (!fetchedPrivateApiKey) {
         console.log("Widget: Private API Key not cached, attempting to fetch for search...");
         // Call the function to fetch and wait for it, but allow it to fail gracefully
         await fetchPrivateApiKey().catch(err => console.error("Widget Error: Failed to fetch Private API Key during search attempt:", err));
     }

     if (!fetchedPrivateApiKey) {
          displaySearchMessage("Clé API Privée non configurée. Impossible de rechercher. Contactez l'administrateur.", 'error');
          console.error("Widget Error: Private API Key is not available for search.");
         searchLoader.style.display = 'none';
         searchButton.disabled = false;
         return;
     }

    console.log(`Widget: Searching FedaPay for transaction key: ${transactionKey} using Private API Key (starts with ${fetchedPrivateApiKey.substring(0,8)}...)...`);
    displaySearchMessage("Recherche de la transaction...", 'info');

    try {
        // Construct the API URL.
        // Add per_page=5000 as requested, though subject to FedaPay API limits.
        // The API is expected to return only matching transactions when transaction_key is used.
        const url = `${FEDAPAY_SEARCH_API_URL}?transaction_key=${encodeURIComponent(transactionKey)}&per_page=5000`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${fetchedPrivateApiKey}`, // USE THE PRIVATE KEY HERE
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            let errorText = `Erreur API FedaPay (${response.status}).`;
            try {
                const errorData = await response.json();
                console.error("FedaPay Search Error JSON:", errorData);
                if (errorData && errorData.message) {
                    errorText = `Erreur FedaPay: ${errorData.message}`;
                } else if (errorData && errorData.error) {
                    errorText = `Erreur FedaPay: ${errorData.error}`;
                }
            } catch (jsonError) {
                console.warn("Failed to parse FedaPay error response as JSON:", jsonError);
                errorText = `Erreur API FedaPay (${response.status}). Réponse non-JSON.`;
                 // Fallback to raw text if JSON parsing fails
                 try {
                     const rawText = await response.text();
                     console.warn("FedaPay raw error response:", rawText);
                     errorText += ` Détails: ${rawText.substring(0, 100)}...`; // Limit length
                 } catch (txtErr) {
                      console.warn("Failed to get raw error response text:", txtErr);
                 }
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        console.log("FedaPay Search Response Data:", data);


        const transactions = data && data['v1/transactions'] ? data['v1/transactions'] : [];

        if (!Array.isArray(transactions) || transactions.length === 0) {
            displaySearchMessage("Aucune transaction trouvée avec cette clé par FedaPay.", 'error');
            console.warn("Widget: FedaPay search returned no transactions for the key.");
            searchLoader.style.display = 'none';
            searchButton.disabled = false;
            return;
        }

        // --- Search Logic (based on your correction) ---
        // Although the API filters by transaction_key, find the exact match in the returned list
        const foundTransaction = transactions.find(tx => tx.transaction_key === transactionKey);

        if (!foundTransaction) {
             // This case should ideally not happen if the API filtered correctly,
             // but it's a safety check based on your description.
             displaySearchMessage("Id de transaction non trouvée.", 'error');
             console.warn(`Widget: Transaction with key "${transactionKey}" not found in the returned list despite API filtering.`);
             searchLoader.style.display = 'none';
             searchButton.disabled = false;
             return; // Stop the process here
        }
        // --- End Search Logic ---


        const transactionDescription = foundTransaction.description;
        const fedapayTransactionId = foundTransaction.id; // Capture FedaPay's transaction ID
        const fedapayTransactionStatus = foundTransaction.status; // Capture FedaPay's status


        console.log(`Widget: FedaPay transaction found. Description: "${transactionDescription}", FedaPay ID: ${fedapayTransactionId}, Status: ${fedapayTransactionStatus}`);


        // Check if the transaction status indicates success or pending (not canceled/failed/declined)
        // Only proceed to show/provide tickets for payments that are completed or pending.
        // Adjust statuses based on your FedaPay flow if needed.
        const isSuccessfulStatus = ['approved', 'completed', 'pending'].includes(fedapayTransactionStatus.toLowerCase());

        if (!isSuccessfulStatus) {
             displaySearchMessage(`Transaction trouvée mais statut "${fedapayTransactionStatus}". Ticket non délivré.`, 'error');
             console.warn(`Widget: Transaction status ${fedapayTransactionStatus} is not considered successful for ticket delivery.`);
             searchLoader.style.display = 'none';
             searchButton.disabled = false;
             return; // Do not proceed to Firebase lookup for non-successful transactions
        }


        displaySearchMessage("Transaction trouvée. Recherche du ticket dans notre base...", 'info');

        // The description should contain the internal transactionUserId generated by our widget
        // Assuming the description IS the transactionUserId
        const internalTransactionUserId = transactionDescription;


        if (!internalTransactionUserId || internalTransactionUserId.length < 10) { // Add a basic length check
            displaySearchMessage("La description de la transaction ne contient pas un ID de ticket valide.", 'error');
            console.error(`Widget Error: FedaPay transaction description "${transactionDescription}" does not appear to be a valid internal ticket ID.`);
            searchLoader.style.display = 'none';
            searchButton.disabled = false;
            return;
        }

        console.log(`Widget: Searching Firebase TransactionUserMap for internal ID: ${internalTransactionUserId}`);
        const userMapRef = ref(db, `users-data/${adminUserId}/TransactionUserMap/${internalTransactionUserId}`); // Use adminUserId for path
        const ticketSnapshot = await get(userMapRef);

        if (ticketSnapshot.exists()) {
            const ticketData = ticketSnapshot.val();
            console.log("Widget: Ticket details found in Firebase TransactionUserMap:", ticketData);

            // Format the ticket data to match what showWidgetNotification expects
            // Ensure all necessary properties are included from ticketData
            const foundTicket = {
                user: ticketData.user,
                password: ticketData.password,
                price: ticketData.price, // Include price
                category: ticketData.category, // Include category
                vendor: ticketData.vendor, // Include vendor
                transactionUserId: internalTransactionUserId, // Our internal ID
                transactionId: fedapayTransactionId // FedaPay's transaction ID
                // Add other fields if necessary
            };

            hideSearchModal(); // Hide the search modal
            searchLoader.style.display = 'none'; // Hide loader just in case
            searchButton.disabled = false; // Enable button just in case

            // Show the ticket notification popup with the found ticket data
            // Use true for isTicketPurchase so it displays the ticket details structure.
            showWidgetNotification("Ticket trouvé!", "Voici les détails de votre ticket.", true, foundTicket);

        } else {
            displaySearchMessage("Ticket introuvable dans notre base de données avec cet ID interne. Contactez l'administrateur.", 'error');
            console.warn(`Widget: Ticket details not found in TransactionUserMap for ID: ${internalTransactionUserId} for admin ${adminUserId}.`);
            searchLoader.style.display = 'none';
            searchButton.disabled = false;
        }

    } catch (error) {
        console.error("Widget Error during FedaPay search or Firebase lookup:", error);
        displaySearchMessage(`Échec de la recherche : ${error.message}`, 'error');
        searchLoader.style.display = 'none';
        searchButton.disabled = false;
    }
}


// --- UI Functions ---
// Show a notification popup within the widget container
// MODIFIED: Removed Connect and Delete buttons for ticket purchase notification. Only shows a "Fermer" button.
window.showWidgetNotification = function(title, message, isTicketPurchase = false, ticket = null) {
    if (!notificationPopup || !notificationTitle || !notificationMessage) {
        console.error("Widget Error: Notification elements not found for display.");
        return;
    }

    notificationTitle.textContent = title;
    notificationMessage.innerHTML = ''; // Clear previous message content

    // Remove any dynamically added buttons from previous notifications
    // This is still necessary if different types of notifications were added later
    const existingButtons = notificationPopup.querySelectorAll('.widget-connect-button, .widget-close-button, .widget-delete-button, .widget-close-ticket-button'); // Added .widget-close-ticket-button class
    existingButtons.forEach(button => button.remove());

    // Ensure close icon is present and has listener
    let closeIcon = notificationPopup.querySelector('.widget-close-icon');
     if (!closeIcon) {
         closeIcon = document.createElement('span');
         closeIcon.className = 'widget-close-icon';
         closeIcon.innerHTML = '×'; // Use times symbol
         // Append close icon to the notification content area, before other content
          const notificationHeader = notificationPopup.querySelector('.widget-notification-header'); // Assuming there's a header div
          if (notificationHeader) {
               notificationHeader.insertBefore(closeIcon, notificationHeader.firstChild);
          } else {
              // Fallback if no header
              notificationPopup.insertBefore(closeIcon, notificationPopup.firstChild);
          }

     }
      // Ensure listener is attached even if icon existed or was just added
     // Remove potential duplicate listeners before adding
     closeIcon.removeEventListener('click', hideWidgetNotification);
     closeIcon.addEventListener('click', hideWidgetNotification);


    if (isTicketPurchase && ticket && ticket.user) { // Ensure ticket object and user exist
        // If it's a ticket purchase notification, display ticket details
        const ticketInfoDiv = document.createElement('div');
        ticketInfoDiv.className = 'widget-ticket-info';
        // Display ticket details
        ticketInfoDiv.innerHTML = `
            <p>Utilisateur: <strong>${escapeHtml(ticket.user || 'N/A')}</strong></p>
            <p>Mot de passe: <strong>${escapeHtml(ticket.password || 'N/A')}</strong></p>
            ${ticket.price != null ? `<p>Prix: ${escapeHtml(ticket.price)} F</p>` : ''}
            <p>Catégorie: ${escapeHtml(ticket.category || ticket.ticketName || 'N/A')}</p>
    `;
        notificationMessage.appendChild(ticketInfoDiv);

         // MODIFIED: Add only a "Fermer" button for ticket notifications
        const closeButton = document.createElement('button');
        closeButton.className = 'widget-close-button'; // Use the standard close button class
        closeButton.textContent = 'Fermer';
        closeButton.addEventListener('click', hideWidgetNotification);
        notificationPopup.appendChild(closeButton);


    } else {
        // If it's a standard message (error, info, cancellation)
        const messagePara = document.createElement('p');
        // Use textContent for safety unless message contains intentional HTML
        messagePara.textContent = message;
        notificationMessage.appendChild(messagePara);

        // Add a simple Close button for non-ticket messages
        const closeButton = document.createElement('button');
        closeButton.className = 'widget-close-button';
        closeButton.textContent = 'Fermer';
        closeButton.addEventListener('click', hideWidgetNotification);
        notificationPopup.appendChild(closeButton);
    }

    // Add error class for styling based on title keywords
    if (title.toLowerCase().includes('erreur') || title.toLowerCase().includes('indisponible') || title.toLowerCase().includes('annulé') || title.toLowerCase().includes('non confirmé') || title.toLowerCase().includes('impossible') || title.toLowerCase().includes('avertissement')) {
         notificationPopup.classList.add('error');
    } else {
         notificationPopup.classList.remove('error');
    }


    // Display the popup
    notificationPopup.style.display = 'block';
}

 // Hide the notification popup
window.hideWidgetNotification = function() {
     if(notificationPopup) {
         notificationPopup.style.display = 'none';
         notificationPopup.classList.remove('error'); // Remove error class
         // Optional: Clear message content and remove dynamic buttons when hidden
         // This prevents old content/buttons from flashing if the modal is reopened quickly.
         // notificationTitle.textContent = '';
         // notificationMessage.innerHTML = '';
         // const dynamicButtons = notificationPopup.querySelectorAll('.widget-connect-button, .widget-close-button, .widget-delete-button, .widget-close-ticket-button'); // Include the new class
         // dynamicButtons.forEach(button => button.remove());
     }
}

// Reads the locally stored ticket and shows the notification
function showStoredTicketNotification() {
    const storedTicketItem = localStorage.getItem('storedTicket');
    if (storedTicketItem) {
        try {
            const ticket = JSON.parse(storedTicketItem);
            // Validate the parsed ticket object
            // Ensure essential properties exist, not just user. Added checks for password and category.
            if (ticket && typeof ticket === 'object' && ticket.user && ticket.password !== undefined && ticket.category !== undefined) {
                console.log("Widget: Showing stored ticket:", ticket.user);
                // Pass the parsed ticket object directly to showWidgetNotification
                // Use true for isTicketPurchase so it displays the ticket details structure,
                // but the showWidgetNotification function itself now only adds a "Fermer" button.
                showWidgetNotification("Votre ticket", "Voici les détails de votre ticket stocké localement.", true, ticket);
            } else {
                console.error("Widget Error: Invalid stored ticket data in localStorage, clearing it.");
                removeStoredTicketLocally(); // Clear invalid data
                showWidgetNotification("Erreur", "Ticket stocké invalide ou incomplet, supprimé. Payez un nouveau ticket.", false);
            }
        } catch (e) {
            console.error("Widget Error: Error parsing stored ticket from localStorage:", e);
            removeStoredTicketLocally(); // Clear on parse error
             showWidgetNotification("Erreur", "Erreur lors de la lecture du ticket stocké, supprimé. Payez un nouveau ticket.", false);
        }
    } else {
         console.log("Widget: No stored ticket found in localStorage.");
         // If called from "Voir mon ticket" flow and no ticket is found, show a passive message.
         showWidgetNotification("Information", "Aucun ticket n'est stocké localement sur ce navigateur.", false);
    }
}

// Updates the text of the main widget button based on local storage
function updateButtonText() {
    if (!payTicketButton) return; // Ensure button element exists
    const storedTicket = localStorage.getItem('storedTicket');
    payTicketButton.textContent = storedTicket ? 'Voir mon ticket' : 'Payer un ticket';
     // console.log("Widget: Main button text updated."); // Avoid excessive logging
}

// Handler for the main widget button click
function handlePayTicketButtonClick() {
    const storedTicketItem = localStorage.getItem('storedTicket');
    if (storedTicketItem) {
        // If a ticket is stored, show the stored ticket notification
        showStoredTicketNotification();
    } else {
        // If no ticket is stored, scroll to the rates section
        if(ratesSection) {
             ratesSection.scrollIntoView({ behavior: 'smooth' });
             console.log("Widget: Scrolling to rates section.");
        } else {
             console.warn("Widget: Rates section element not found for scrolling.");
        }
    }
}


// --- Auto-Initialization Trigger ---
// Call the new main setup function to start the process
// It will handle DOMContentLoaded internally or run immediately if DOM is ready
startWidgetSetup();

// --- Make functions globally accessible if needed by the main page ---
// This is necessary if the main page (payer.html, likely a Mikrotik portal page) calls these functions
window.showWidgetNotification = showWidgetNotification;
window.hideWidgetNotification = hideWidgetNotification;
window.autoLogin = autoLogin; // Make autoLogin available globally for potential custom button/logic
window.initPayment = initPayment; // Although typically called by button handlers, make it global
window.storeConnectedTicket = storeConnectedTicket; // Keep this global for consistency, although its primary call is from autoLogin now.
})(); // End of IIFE