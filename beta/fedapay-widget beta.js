
// fedapay-widget.js - VERSION OPTIMISÉE AVEC RÉCONCILIATION CLIENT

// Wrap everything in an IIFE to avoid polluting the global scope
(function() {
    // --- Configuration ---
    // These are PLACEHOLDERS, values will be injected by index.html
    let adminUserId = '<!-- ADMIN_USER_ID -->'; // Make these `let` as they might be overridden by shortlink
    let fedapayApiKey = '<!-- FEDAPAY_API_KEY -->'; // <--- REPLACE WITH YOUR LIVE FEDAPAY PUBLIC KEY --- // Make `let`
    const fedapayLink = '<!-- DIRECT_PAYMENT_LINK -->'; // This one is likely static per admin, keep const


    // IMPORTANT SECURITY WARNING:
    // Accessing the Private API Key client-side for the transaction search endpoint
    // (which expects a Private Key) is generally NOT recommended in production environments
    // as it exposes your Private Key in the browser's code and network requests.
    // This implementation follows the structure seen in your Recherche transaction.html
    // for this specific function, but be aware of the security implications.
    // A more secure approach would be to proxy this API call through a server-side endpoint
    // (e.g., Firebase Cloud Function) that holds your Private Key securely.
    // We will fetch the Private Key from Firebase as configured in index.html for this function.

    const firebaseConfigManagerPath = './firebase-config-manager.js';

    // FedaPay API URL for transaction search
    const FEDAPAY_SEARCH_API_URL = 'https://api.fedapay.com/v1/transactions/search';


    // --- Configuration for Retries ---
    const MAX_LOAD_RETRIES = 5;
    const RETRY_DELAY_MS = 2500;
    const MAX_SALE_RETRIES = 10; // Max attempts to find a non-duplicate ticket

    // --- Widget State ---
    let db = null; // Initialize as null
    let availableOfferingsCache = {}; // MODIFIÉ: Cache pour les offres du widget (léger)
    let widgetInitialized = false;
    let fetchedPrivateApiKey = null; // Variable to store the fetched Private API Key


    // --- DOM Element References ---
    let payTicketButton, ratesSection, loadingMessage, optionsContainer, notificationPopup, notificationTitle, notificationMessage;
    let directLinkContainer, linkInstruction, linkArea, directLinkElement;
    let tooltip; // For quick messages

    // NEW DOM References for "Ticket Not Received" feature
    let ticketNotReceivedButton;
    let searchModal;
    let searchInput;
    let searchButton;
    let searchMessage;
    let searchLoader;


    // --- Firebase SDK Modules (to be loaded) ---
    let getActiveDatabase, ref, get, set, push, remove, runTransaction;


    // NOUVEAU : Fonction pour afficher un "squelette" des offres pendant le chargement
    function displaySkeletonOfferings(count = 3) {
        if (!optionsContainer || !loadingMessage) return;

        console.log("Widget: Displaying skeleton loaders for offerings...");
        
        // Cacher le message de chargement textuel
        loadingMessage.style.display = 'none';
        
        // Vider le conteneur et le rendre visible
        optionsContainer.innerHTML = '';
        optionsContainer.style.display = 'flex'; 

        for (let i = 0; i < count; i++) {
            const skeletonDiv = document.createElement('div');
            skeletonDiv.className = 'widget-dynamic-ticket-option skeleton-offering'; // Utilise les classes de la grille existante + la nouvelle

            const skeletonText = document.createElement('div');
            skeletonText.className = 'skeleton-text';

            const skeletonButton = document.createElement('div');
            skeletonButton.className = 'skeleton-button';

            skeletonDiv.appendChild(skeletonText);
            skeletonDiv.appendChild(skeletonButton);
            optionsContainer.appendChild(skeletonDiv);
        }
    }


// --- Initialization ---
async function initializeWidget() {
    console.log("Widget: Starting initialization...");
    const widgetContainer = document.getElementById('fedapay-ticket-widget-container');
    if (!widgetContainer) {
        console.error("Fedapay Widget Critical Error: Could not find the main widget container #fedapay-ticket-widget-container. Widget cannot initialize.");
        if (document.body) document.body.innerHTML = "<p style='color: red; text-align: center; margin-top: 50px;'>Fedapay Widget Critical Error: Impossible de charger le widget. Conteneur principal introuvable (#fedapay-ticket-widget-container).</p>";
        return;
    }

    // Get DOM elements within the container
    payTicketButton = widgetContainer.querySelector('#widget-payTicketButton');
    ratesSection = widgetContainer.querySelector('.widget-rates-section');
    loadingMessage = widgetContainer.querySelector('.widget-loading-message');
    optionsContainer = widgetContainer.querySelector('#widget-dynamic-ticket-options');
    notificationPopup = widgetContainer.querySelector('.widget-notification');
    tooltip = widgetContainer.querySelector('#widget-tooltip');

    // NEW DOM References for "Ticket Not Received" feature
    ticketNotReceivedButton = document.createElement('button');
    ticketNotReceivedButton.id = 'widget-ticketNotReceivedButton';
    ticketNotReceivedButton.textContent = 'Ticket payé non reçu?';
    ticketNotReceivedButton.className = 'widget-check-ticket-button';


    // Create the new modal dynamically
    searchModal = document.createElement('div');
    searchModal.id = 'widget-search-modal';
    searchModal.className = 'widget-search-modal';
    searchModal.innerHTML = `
        <h2>Rechercher un Ticket</h2>
        <span class="widget-close-icon">×</span>
        <p>Entrez l'id de transaction reçue par SMS après votre paiement.</p>
        <input type="text" placeholder="ID de Transaction" id="widget-search-input">
        <button id="widget-search-button">Rechercher</button>
        <div class="widget-search-message" id="widget-search-message"></div>
         <div class="widget-search-loader" id="widget-search-loader"></div>
    `;


    if (notificationPopup) {
        notificationTitle = notificationPopup.querySelector('#widget-notification-title');
        notificationMessage = notificationPopup.querySelector('#widget-notification-message');
    }

    // Check if essential elements are found - CRITICAL ERROR
    if (!payTicketButton || !ratesSection || !loadingMessage || !optionsContainer || !notificationPopup || !notificationTitle || !notificationMessage ) {
         const missingElement = !payTicketButton ? '#widget-payTicketButton' :
                               !ratesSection ? '.widget-rates-section' :
                               !loadingMessage ? '.widget-loading-message' :
                               !optionsContainer ? '#widget-dynamic-ticket-options' :
                               !notificationPopup ? '.widget-notification' :
                               !notificationTitle ? '#widget-notification-title' :
                               !notificationMessage ? '#widget-notification-message' :
                                'unknown essential element';
        console.error(`Fedapay Widget Critical Error: Could not find required HTML element "${missingElement}" within the widget container.`);
         if (widgetContainer) widgetContainer.innerHTML = `<p style='color: red; text-align: center;'>Erreur critique: Impossible de charger le widget. Élément manquant: ${missingElement}.</p>`;
        return;
    }
    console.log("Widget: All required DOM elements found.");

    // --- NOUVEAU : AFFICHER LE SQUELETTE IMMÉDIATEMENT ---
    // On affiche une grille factice pour donner une impression de chargement instantané.
    // Cela remplace l'affichage du message "Chargement initial des composants...".
    displaySkeletonOfferings(3); // Affiche 3 placeholders
    // --------------------------------------------------------

    // Append the new button and modal to the container
    if (payTicketButton && payTicketButton.parentNode) {
         payTicketButton.parentNode.insertBefore(ticketNotReceivedButton, payTicketButton.nextSibling);
         console.log("Widget: 'Ticket payé non reçu ?' button added.");
    } else {
          console.warn("Widget: Could not add 'Ticket payé non reçu ?' button, main button parent not found.");
          ticketNotReceivedButton = null;
    }
    widgetContainer.appendChild(searchModal);


    // Get references to the new modal elements after appending
    if(searchModal){
         searchInput = searchModal.querySelector('#widget-search-input');
         searchButton = searchModal.querySelector('#widget-search-button');
         searchMessage = searchModal.querySelector('#widget-search-message');
         searchLoader = searchModal.querySelector('#widget-search-loader');
         const searchModalCloseIcon = searchModal.querySelector('.widget-close-icon');
          if (searchModalCloseIcon) {
             searchModalCloseIcon.addEventListener('click', hideSearchModal);
         }
         if (searchButton) {
             searchButton.addEventListener('click', handleSearchTicket);
         }
         if (searchInput) {
             searchInput.addEventListener('keypress', function(event) {
                 if (event.key === 'Enter') {
                     event.preventDefault();
                     handleSearchTicket();
                 }
             });
         }
    } else {
         console.warn("Widget: Search modal creation failed, search feature disabled.");
    }


    // --- NOUVEAU CODE : Ajout du lien de paiement direct (SANS BOUTON COPIER) ---
    console.log("Widget: Adding direct FedaPay link block (without copy button).");

    directLinkContainer = document.createElement('div');
    directLinkContainer.id = 'widget-direct-link-container';
    directLinkContainer.className = 'widget-direct-link-block';

    linkInstruction = document.createElement('p');
    linkInstruction.className = 'widget-link-instruction';
    linkInstruction.textContent = 'Si vous rencontrez des difficultés avec le paiement par le formulaire ci-dessus, copiez ce lien et ouvrez-le dans votre navigateur :';
    directLinkContainer.appendChild(linkInstruction);

    linkArea = document.createElement('div');
    linkArea.className = 'widget-link-area';
    directLinkContainer.appendChild(linkArea);

    directLinkElement = document.createElement('input');
    directLinkElement.type = 'text';
    directLinkElement.id = 'widget-direct-link';
    directLinkElement.className = 'widget-direct-link';
    directLinkElement.value = fedapayLink;
    directLinkElement.readOnly = true;

    linkArea.appendChild(directLinkElement);

    if (payTicketButton && payTicketButton.parentNode) {
         payTicketButton.parentNode.insertBefore(directLinkContainer, payTicketButton);
         console.log("Widget: Direct link block inserted before main button.");
         if (directLinkContainer) directLinkContainer.style.display = 'block';
    } else {
         console.warn("Widget: Could not insert direct link block, main button parent not found.");
         directLinkContainer = null;
    }
    // --- Fin NOUVEAU CODE (SANS BOUTON COPIER) ---


    // MODIFIÉ: Set initial state: Le squelette remplace le message de chargement.
    loadingMessage.style.display = 'none';      // On cache le message texte
    optionsContainer.style.display = 'flex';    // On affiche le conteneur qui contient le squelette
    ratesSection.style.display = 'block';       // Titre de la section visible
    payTicketButton.style.display = 'none';     // Bouton principal caché jusqu'à ce que de vraies options soient là
    if (ticketNotReceivedButton) ticketNotReceivedButton.style.display = 'block';
    if (directLinkContainer) directLinkContainer.style.display = 'block';

     // --- Check for FedaPay API Key configuration ---
     if (!fedapayApiKey || fedapayApiKey.startsWith('<!--') || fedapayApiKey === 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY') {
          const msg = "Erreur Configuration: Clé API Publique FedaPay non configurée pour le widget.";
          console.error(`Fedapay Widget Error: ${msg} API Key: "${fedapayApiKey}"`);
          if (loadingMessage) loadingMessage.textContent = msg + " Le paiement par formulaire est désactivé. Vous pouvez utiliser le lien direct ci-dessus si disponible.";
          if (optionsContainer) optionsContainer.style.display = 'none'; // On cache le squelette si erreur critique de clé
          if (loadingMessage) loadingMessage.style.display = 'block';   // Et on affiche le message d'erreur
          if (payTicketButton) payTicketButton.style.display = 'none';

           console.warn("FedaPay Public key missing. Payment functionality disabled.");
     } else {
          console.log(`Fedapay Widget: FedaPay Public API Key (${fedapayApiKey.substring(0,8)}...) loaded.`);
     }


    // --- Load Firebase dependencies with Retry Logic ---
    let loadAttempts = 0;
    let dependenciesLoaded = false;

    while (loadAttempts < MAX_LOAD_RETRIES && !dependenciesLoaded) {
        loadAttempts++;
        if (loadAttempts > 1) {
            // Si le chargement échoue, on remplace le squelette par un message d'erreur.
            if (optionsContainer) optionsContainer.style.display = 'none';
            if (loadingMessage) {
                loadingMessage.textContent = `Tentative de chargement ${loadAttempts}/${MAX_LOAD_RETRIES}... (Connexion instable détectée)`;
                loadingMessage.style.display = 'block';
            }
            console.log(`Widget: Waiting ${RETRY_DELAY_MS / 1000}s before retry #${loadAttempts}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }

        console.log(`Widget: Attempting to load dependencies (Attempt ${loadAttempts})`);
        try {
            const dbFunctionsPromise = import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js");
            const configManagerPromise = import(firebaseConfigManagerPath);

            const [dbFunctions, configManagerModule] = await Promise.all([dbFunctionsPromise, configManagerPromise]);

            ref = dbFunctions.ref;
            get = dbFunctions.get;
            set = dbFunctions.set;
            push = dbFunctions.push;
            remove = dbFunctions.remove;
            runTransaction = dbFunctions.runTransaction;
            getActiveDatabase = configManagerModule.getActiveDatabase;

            if (typeof runTransaction !== 'function') {
                throw new Error("Firebase Database SDK version does not support runTransaction.");
            }

            console.log("Widget: Firebase SDK and Config Manager loaded successfully.");
            dependenciesLoaded = true;

        } catch (error) {
            console.warn(`Fedapay Widget Error: Failed to load dependencies on attempt ${loadAttempts}.`, error);
             if (error.message.includes('runTransaction')) {
                  console.error("Fedapay Widget Critical Error: Incompatible Firebase SDK version or missing runTransaction function.");
             }
        }
    }

    if (!dependenciesLoaded) {
        console.error("Fedapay Widget Critical Error: Failed to load Firebase dependencies after multiple retries. Aborting initialization.");
        const msg = "Erreur critique: Impossible de charger les composants requis après plusieurs tentatives. Veuillez vérifier votre connexion internet et rafraîchir la page.";
        if (optionsContainer) optionsContainer.style.display = 'none'; // Cache le squelette
        if (loadingMessage) loadingMessage.textContent = msg; // Affiche le message d'erreur final
        loadingMessage.style.display = 'block';

        db = null;
        return;
    }

    // --- Dependencies loaded successfully, proceed with DB initialization ---
    let determinedAdminUserId = null;
    let determinedApiKey = null;
    let mainAdminUserIdForLookup = null;

    const urlParams = new URLSearchParams(window.location.search);
    const shortParam = urlParams.get('s');

    // On affiche un message temporaire par-dessus le squelette pendant la recherche de config
    if (shortParam) {
        loadingMessage.textContent = "Recherche de la configuration...";
        loadingMessage.style.display = 'block'; // Afficher temporairement
        optionsContainer.style.display = 'none'; // Cacher le squelette pendant ce message
    }


    if (shortParam) {
        console.log(`Widget: Found short parameter 's': ${shortParam}. Attempting lookup.`);
        const parts = shortParam.split('_');
        if (parts.length === 2 && parts[0] && parts[1]) {
            mainAdminUserIdForLookup = parts[0];
            const shortcode = parts[1];
            try {
                const lookupDb = await getActiveDatabase(mainAdminUserIdForLookup);
                 if (!lookupDb) throw new Error("Failed to initialize temporary database for lookup.");
                const lookupRef = ref(lookupDb, `users-data/${mainAdminUserIdForLookup}/shortenedLinks/${shortcode}`);
                const snapshot = await get(lookupRef);
                if (snapshot.exists()) {
                    const linkData = snapshot.val();
                    if (linkData && linkData.userId && linkData.apiKey) {
                        determinedAdminUserId = linkData.userId;
                        determinedApiKey = linkData.apiKey;
                        console.log(`Widget: Lookup successful. Determined user: ${determinedAdminUserId}, PUBLIC API key: ${determinedApiKey ? determinedApiKey.substring(0,8)+'...' : 'N/A'}`);
                         loadingMessage.textContent = "Configuration trouvée."; // Message de succès
                    } else {
                        const msg = "Erreur: Les données du lien raccourci sont incomplètes ou invalides.";
                         console.error("Widget Error:", msg, linkData);
                         loadingMessage.textContent = msg;
                         return;
                    }
                } else {
                     const msg = "Erreur: Lien raccourci introuvable ou expiré.";
                     console.warn("Widget Warning:", msg, shortParam);
                     loadingMessage.textContent = msg;
                     return;
                }
            } catch (error) {
                 const msg = `Erreur lors de la recherche du lien raccourci : ${error.message}`;
                 console.error("Widget Error:", msg, error);
                 loadingMessage.textContent = msg;
                 return;
            }
        } else {
            console.log("Widget: No short parameter 's' found. Falling back to userId/apiKey parameters or embedded values.");
            determinedAdminUserId = urlParams.get('userId') || adminUserId;
            determinedApiKey = urlParams.get('apiKey') || fedapayApiKey;
            console.warn("Widget Warning: Using deprecated URL parameters or placeholders. Use the shortlink 's' parameter for production.");
        }
    } else {
         console.log("Widget: No short parameter 's' found. Falling back to userId/apiKey parameters or embedded values.");
         determinedAdminUserId = urlParams.get('userId') || adminUserId;
         determinedApiKey = urlParams.get('apiKey') || fedapayApiKey;
          console.warn("Widget Warning: Using deprecated URL parameters or placeholders. Use the shortlink 's' parameter for production.");
    }
    
    // Une fois la config trouvée, on peut recacher le message et ré-afficher le squelette
    if (shortParam) {
        loadingMessage.style.display = 'none';
        optionsContainer.style.display = 'flex';
    }


    const isPlaceholderUserId = determinedAdminUserId.startsWith('<!--') || determinedAdminUserId === '';
    const isPlaceholderApiKey = determinedApiKey.startsWith('<!--') || determinedApiKey === 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY';

    if (isPlaceholderUserId) {
         const msg = "Erreur de configuration: L'ID utilisateur est manquant(e) ou invalide.";
         console.error("Fedapay Widget Critical Error:", msg);
         if(optionsContainer) optionsContainer.style.display = 'none'; // Cache le squelette
         loadingMessage.textContent = msg + " Veuillez contacter l'administrateur.";
         loadingMessage.style.display = 'block';
         if (ratesSection) ratesSection.style.display = 'none';
         if (payTicketButton) payTicketButton.style.display = 'none';
         if (ticketNotReceivedButton) ticketNotReceivedButton.style.display = 'none';
         if (directLinkContainer) directLinkContainer.style.display = 'none';
         db = null;
         return;
    }

     adminUserId = determinedAdminUserId;
     fedapayApiKey = determinedApiKey;

    console.log("Widget: Configuration validated. Initializing main database for user:", adminUserId);

    try {
         db = await getActiveDatabase(adminUserId);
         if (!db) {
              throw new Error("getActiveDatabase returned null or undefined for main user " + adminUserId);
         }
         console.log("Widget: Main Firebase Database initialized for user:", adminUserId);
         
         // === MODIFICATION SOLUTION 1 ===
         // La récupération de la clé privée est DIFFÉRÉE.
         // Elle sera chargée uniquement lorsque l'utilisateur cliquera sur le bouton de recherche.
         console.log("Widget: Private API Key fetch deferred until needed for search.");
         // await fetchPrivateApiKey().catch(err => console.warn("Widget Warning: Initial Private API Key fetch failed:", err));
         
    } catch (error) {
        console.error("Fedapay Widget Critical Error: Failed to initialize main Firebase Database:", error);
         const msg = 'Erreur critique: Échec de l\'initialisation de la base de données. Veuillez vérifier votre connexion.';
         if(optionsContainer) optionsContainer.style.display = 'none'; // Cache le squelette
         loadingMessage.textContent = msg;
         loadingMessage.style.display = 'block';
         if (ratesSection) ratesSection.style.display = 'none';
         if (payTicketButton) payTicketButton.style.display = 'none';
         if (ticketNotReceivedButton) ticketNotReceivedButton.style.display = 'none';
         if (directLinkContainer) directLinkContainer.style.display = 'none';
        db = null;
         removeStoredTicketLocally();
        return;
    }

    // --- Main DB initialized successfully, proceed with widget logic ---
    console.log("Widget: Database ready. Proceeding with sync and listeners.");

    const loginForm = document.forms.login;
    if (loginForm) {
         console.log("Widget: Found login form. Attempting to add submit listener for username capture.");
        loginForm.addEventListener('submit', async function(event) {
             const usernameInput = loginForm.elements.username;
             if (usernameInput && usernameInput.value) {
                  const username = usernameInput.value.trim();
                  if (username) {
                      console.log(`Widget: Login form submitted, capturing username for TicketConnecté: ${username}`);
                      if (db && adminUserId && !adminUserId.startsWith('<!--')) {
                          await storeConnectedTicket(username);
                      } else {
                          console.warn("Widget: DB or adminId invalid, cannot store connected ticket username on form submit.");
                      }
                  } else {
                      console.warn("Widget: Login form submitted but username value is empty.");
                  }
             } else {
                 console.warn("Widget: Login form submitted but username field missing.");
             }
         });
    } else {
        console.warn("Widget: Login form element not found (forms.login). Cannot attach username capture listener.");
    }

    if (payTicketButton) {
        payTicketButton.addEventListener('click', handlePayTicketButtonClick);
    } else {
         console.warn("Widget: Main payTicketButton element not found.");
    }

    const closeIcon = notificationPopup ? notificationPopup.querySelector('.widget-close-icon') : null;
    if (closeIcon) {
         closeIcon.removeEventListener('click', hideWidgetNotification);
         closeIcon.addEventListener('click', hideWidgetNotification);
    } else {
        console.warn("Widget: Notification close icon element not found for listener.");
    }

    if (ticketNotReceivedButton) {
         ticketNotReceivedButton.addEventListener('click', showSearchModal);
    }

    // L'appel à syncAndDisplayOfferings va remplacer les squelettes par les vrais tickets.
    await syncAndDisplayOfferings(); 

    reconcileAndUpdateOfferings().catch(err => {
        console.warn("Widget: Background offering reconciliation failed.", err);
    });

    updateButtonText(); 

    if (db && adminUserId && !adminUserId.startsWith('<!--')) {
        setInterval(syncAndDisplayOfferings, 60000);
        console.log("Widget: Periodic quick sync started.");
    } else {
        console.warn("Widget: DB/adminId is null/invalid after init, periodic sync will not start.");
    }

    widgetInitialized = true;
    console.log("Fedapay Ticket Widget Initialized successfully.");
}


    // NEW: Function to fetch the Private API Key from Firebase
    async function fetchPrivateApiKey() {
        // This function is now called *after* the main DB instance `db` is initialized
        // and the final `adminUserId` is determined in `initializeWidget`.
        if (!db || !adminUserId || adminUserId.startsWith('<!--')) {
             console.warn("Widget: Cannot fetch Private API Key, DB or adminId missing/invalid after init.");
            fetchedPrivateApiKey = null; // Ensure it's null if prerequisites fail
            return;
        }
        console.log(`Widget: Attempting to fetch Private API Key for admin ${adminUserId}...`);
        try {
             // Use the new path from index.html config
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


    // --- Subscription Status Check (from fedapay-widget.js) ---
     async function checkSubscriptionStatus() {
         try {
             if (!db || !adminUserId || adminUserId.startsWith('<!--')) { // Ensure adminUserId is valid
                 console.warn("Widget: Database or valid Admin ID not available for subscription check.");
                 return false; // Assume inactive if prerequisites missing
             }
             const userAdminRef = ref(db, `users-data/${adminUserId}/admin/subscription`);
             const snapshot = await get(userAdminRef);
             const subscription = snapshot.val();
             const now = Date.now(); // Use timestamp for comparison

             if (subscription && subscription.status === 'active') {
                  const endDateTimestamp = typeof subscription.endDate === 'string' ? new Date(subscription.endDate).getTime() : subscription.endDate;

                 if (endDateTimestamp < now) {
                     console.warn(`Widget: Admin subscription found but expired on ${new Date(endDateTimestamp).toISOString()}.`);
                     return false;
                 } else {
                     // console.log("Widget: Active subscription found."); // Avoid excessive logging
                     return true; // Active subscription
                 }
             } else {
                 console.warn("Widget: No active admin subscription found for " + adminUserId);
                 return false; // No active subscription
             }
         } catch (error) {
             console.error("Widget Error: Erreur lors de la vérification de l'abonnement :", error);
             return false; // Assume inactive on error
         }
     }

    // --- Core Logic ---

     // This function is called by the main login form handler (e.g., in pay.html) on successful login.
     // It stores the username of the successfully connected ticket.
     async function storeConnectedTicket(username) {
        if (!db || !adminUserId || adminUserId.startsWith('<!--') || !username) {
            console.warn("Widget: Cannot store connected ticket, DB/adminId/username missing or invalid.");
            return;
        }
        try {
           const ticketConnectedRef = ref(db, `users-data/${adminUserId}/TicketConnecté`); // Use adminUserId for path
           const newTicketRef = push(ticketConnectedRef);
           await set(newTicketRef, { username: username, timestamp: new Date().toISOString() });
           console.log(`Widget: Connected ticket username enregistré dans Firebase (${adminUserId}) avec la clé:`, newTicketRef.key);
       } catch (error) {
           console.error("Widget Error: Failed to store connected ticket username:", error);
       }
   }

     // This function seems to be called by the login form in `fedapay-widget.js` context too.
     // It stores ticket credentials locally, typically after purchase for auto-login.
     // However, fedapay-widget.js's login form handler calls it on submit *before* validation,
     // which might not be what's intended if it's for *purchased* tickets.
     // For FedaPay, storeTicketLocally is called after successful purchase in initPayment.
     // This `storeLoginTicket` might be redundant or for a different purpose (e.g. if Mikrotik variables are available on form)
     // Kept for parity, but ensure its usage is correct in your overall flow.
     window.storeLoginTicket = function(username, password) { // Make global as it was in the provided code
            try {
                // This locally stores credentials, perhaps for a non-purchased ticket scenario or debugging.
                // If this is for *purchased* tickets, storeTicketLocally in initPayment is preferred.
                localStorage.setItem('TicketConnecté', JSON.stringify({ // Note: fedapay-widget uses 'TicketConnecté' key here
                    user: username,
                    password: password
                }));
                console.log("Widget: Ticket de connexion (from form) stocké localement via storeLoginTicket:", username);
            } catch (e) {
                 console.error("Widget Error: Failed to store login ticket locally (storeLoginTicket):", e);
            }
        }

     // NOUVEAU: Fonction pour vérifier si un ticket existe dans l'historique de N'IMPORTE QUEL vendeur
     // This function now uses the specific adminUserId
     async function checkIfTicketSoldInAnyHistory(ticketToCheck) {
         if (!db || !adminUserId || adminUserId.startsWith('<!--') || !ticketToCheck || !ticketToCheck.user) {
             console.warn("Widget: Cannot check VendorsHistory, DB/adminId/ticket data missing or invalid.");
             return false; // Assume not sold if we can't check
         }
         console.log(`Widget: Checking VendorsHistory (${adminUserId}) for ticket: ${ticketToCheck.user}`); // Use adminUserId for path and log
         const historyRef = ref(db, `users-data/${adminUserId}/VendorsHistory`);
         try {
             const snapshot = await get(historyRef);
             if (!snapshot.exists()) {
                 console.log("Widget: VendorsHistory node does not exist for this admin. Ticket assumed not sold."); // Updated log message
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

    // =========================================================================
    // === NOUVEAU : Fonction de réconciliation en arrière-plan ===
    // Cette fonction lit `TicketsTotal` et met à jour le cache `widgetOfferings`
    // Elle ne bloque PAS l'affichage initial du widget.
    // =========================================================================
    async function reconcileAndUpdateOfferings() {
        if (!db || !adminUserId || adminUserId.startsWith('<!--')) {
            console.log("Widget Reconciliation: Skipping, DB or AdminID not ready.");
            return;
        }
        
        console.log("Widget Reconciliation: Starting background task to sync offerings with full stock.");

        try {
            const offeringsRef = ref(db, `users-data/${adminUserId}/widgetOfferings`);
            const totalRef = ref(db, `users-data/${adminUserId}/TicketsTotal`);

            // Récupérer simultanément les deux nœuds
            const [offeringsSnapshot, totalSnapshot] = await Promise.all([
                get(offeringsRef),
                get(totalRef)
            ]);

            const currentOfferings = offeringsSnapshot.val() || {}; // État actuel du cache
            const ticketsTotal = totalSnapshot.val() || {}; // État réel du stock

            const updates = {}; // Pour stocker les changements à appliquer au cache `widgetOfferings`
            const actualCategories = new Set(Object.keys(ticketsTotal)); // Catégories réelles dans le stock

            // Étape 1: Vérifier les catégories présentes dans TicketsTotal
            // Mettre à jour ou ajouter dans `widgetOfferings` si l'état diffère
            for (const categoryName of actualCategories) {
                const ticketData = ticketsTotal[categoryName];
                const isAvailable = ticketData && Array.isArray(ticketData.utilisateur) && ticketData.utilisateur.length > 0;
                // Le prix et l'état "isFree" sont tirés du premier ticket ou par défaut
                const price = isAvailable && Array.isArray(ticketData.prix) && ticketData.prix.length > 0 ? ticketData.prix[0] : 0;
                const isFree = categoryName.toLowerCase().includes('ticket cadeau') || categoryName.toLowerCase().includes('gratuit');

                const currentOffering = currentOfferings[categoryName];
                
                // Si l'offre n'existe pas, ou si son état (disponibilité, prix, gratuité) a changé
                if (!currentOffering || 
                    currentOffering.available !== isAvailable || 
                    currentOffering.price !== price ||
                    currentOffering.isFree !== isFree) {
                    updates[categoryName] = {
                        price: price,
                        isFree: isFree,
                        available: isAvailable
                    };
                }
            }

            // Étape 2: Vérifier les offres qui n'existent PLUS dans TicketsTotal
            // Les marquer pour suppression du cache `widgetOfferings`
            for (const categoryName in currentOfferings) {
                if (!actualCategories.has(categoryName)) {
                    updates[categoryName] = null; // Marquer pour suppression
                }
            }

            // Appliquer les mises à jour au nœud `widgetOfferings` si nécessaire
            if (Object.keys(updates).length > 0) {
                console.log("Widget Reconciliation: Found discrepancies, updating widgetOfferings node:", updates);
                // Utilise `update` sur une référence parent pour appliquer des modifications multiples,
                // y compris des suppressions (en mettant la valeur à `null`).
                // Pour une mise à jour complète et la suppression des catégories non mentionnées,
                // on pourrait reconstruire l'objet entier et utiliser `set` sur `offeringsRef`
                // mais `update` est plus efficace pour des changements partiels.
                // Pour cette structure, un `set` de l'objet complet mis à jour est plus simple:
                const updatedOfferings = { ...currentOfferings };
                for (const key in updates) {
                    if (updates[key] === null) {
                        delete updatedOfferings[key]; // Supprimer si marqué null
                    } else {
                        updatedOfferings[key] = updates[key]; // Mettre à jour ou ajouter
                    }
                }
                await set(offeringsRef, updatedOfferings);
                
                // Optionnel: rafraîchir l'UI immédiatement après la réconciliation pour montrer les changements
                await syncAndDisplayOfferings();
                console.log("Widget Reconciliation: widgetOfferings node updated successfully.");
            } else {
                console.log("Widget Reconciliation: No changes needed. Offerings are in sync.");
            }

        } catch (error) {
            console.error("Widget Reconciliation: Error during background offerings sync:", error);
        }
    }


    // =========================================================================
    // === MODIFIÉ : Fonction de synchronisation RAPIDE et d'affichage des offres ===
    // Cette fonction lit UNIQUEMENT le nœud `widgetOfferings` (le cache léger)
    // === MODIFICATION SOLUTION 1 : Appels réseau parallélisés ===
    // =========================================================================
    async function syncAndDisplayOfferings() {
        if (!optionsContainer || !loadingMessage || !payTicketButton || !ratesSection || !ticketNotReceivedButton || !directLinkContainer) {
             console.error("Widget Error: Cannot sync tickets, required DOM elements are missing.");
             return;
        }

        if (!db || !adminUserId || adminUserId.startsWith('<!--')) {
             console.warn("Widget: syncAndDisplayOfferings called but DB/adminId not ready or invalid.");
             loadingMessage.textContent = 'Service de paiement de tickets indisponible (ID Administrateur ou connexion DB manquante).';
             loadingMessage.style.display = 'block';
             optionsContainer.style.display = 'none';
             payTicketButton.style.display = 'none';
             ratesSection.style.display = 'block';
             ticketNotReceivedButton.style.display = 'block';
             if (directLinkContainer) directLinkContainer.style.display = 'block';
             availableOfferingsCache = {};
             removeStoredTicketLocally();
             createTicketOptions(availableOfferingsCache);
             return;
        }

        // === MODIFICATION SOLUTION 1 : Parallélisation des appels ===
        console.log("Widget: [Quick Sync] Fetching subscription status and offerings in parallel...");
        try {
            // Lancer les deux promesses en même temps sans `await`
            const subscriptionPromise = checkSubscriptionStatus();
            const offeringsRef = ref(db, `users-data/${adminUserId}/widgetOfferings`);
            const offeringsPromise = get(offeringsRef);

            // Attendre que les deux soient terminées
            const [isActive, snapshot] = await Promise.all([subscriptionPromise, offeringsPromise]);

            if (!isActive) {
                 console.log("Widget: Subscription inactive, hiding ticket options.");
                 loadingMessage.textContent = 'Service de paiement de tickets indisponible. (Abonnement inactif)';
                 loadingMessage.style.display = 'block';
                 optionsContainer.style.display = 'none';
                 payTicketButton.style.display = 'none';
                 ratesSection.style.display = 'block';
                 ticketNotReceivedButton.style.display = 'block';
                 if (directLinkContainer) directLinkContainer.style.display = 'block';
                 availableOfferingsCache = {};
                 removeStoredTicketLocally();
                 createTicketOptions(availableOfferingsCache);
                 return;
            }

            // La logique continue en utilisant les résultats des promesses
            const fetchedOfferings = snapshot.val() || {};
            availableOfferingsCache = fetchedOfferings;
            createTicketOptions(availableOfferingsCache);

            if (ratesSection) ratesSection.style.display = 'block';
            if (ticketNotReceivedButton) ticketNotReceivedButton.style.display = 'block';
            if (directLinkContainer) directLinkContainer.style.display = 'block';

        } catch (error) {
            console.error("Widget Error: Erreur lors de la synchronisation des offres de tickets pour affichage:", error);
            loadingMessage.textContent = 'Erreur lors du chargement des types de tickets.';
            loadingMessage.style.display = 'block';
            optionsContainer.style.display = 'none';
            payTicketButton.style.display = 'none';
            ratesSection.style.display = 'block';
            ticketNotReceivedButton.style.display = 'block';
            if (directLinkContainer) directLinkContainer.style.display = 'block';
            availableOfferingsCache = {};
            createTicketOptions(availableOfferingsCache);
            removeStoredTicketLocally();
        }
    }

    // Helper function for basic HTML escaping - Used in createTicketOptions and showWidgetNotification
    function escapeHtml(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/[&<>"']/g, function(match) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[match];
        });
    }

    // =========================================================================
    // === MODIFIÉ : createTicketOptions utilise maintenant la structure `widgetOfferings` ===
    // =========================================================================
    function createTicketOptions(offeringsData) {
        // This function uses the data solely to build the UI options.
        // It doesn't guarantee the first ticket shown is actually available or unique.
        if (!optionsContainer || !loadingMessage || !payTicketButton || !ratesSection || !ticketNotReceivedButton || !directLinkContainer) { // Added check for all elements
             console.error("Widget Error: Cannot create ticket options, required DOM elements are missing.");
             return;
        }
        optionsContainer.innerHTML = ''; // Clear previous options

        const categories = Object.keys(offeringsData);
        let offeringsFoundForDisplay = false; // Flag to see if *any* displayable offerings were found

         // Sort categories alphabetically
         categories.sort();

        for (const categoryName of categories) {
             const offering = offeringsData[categoryName];
             // NOUVELLE LOGIQUE : Vérifie la propriété `available` dans le nœud `widgetOfferings`
             if (offering && offering.available === true && offering.price != null) {
                 offeringsFoundForDisplay = true; // Mark that we found something to display
                 
                 const price = offering.price;
                 const isFree = offering.isFree === true; // NOUVEAU : Utilise la propriété `isFree`

                 // Determine button text (e.g., 'Obtenir' for gift/free tickets, 'Payer' otherwise)
                 const buttonText = isFree ? 'Obtenir' : 'Payer'; // Simplifié
                 const amount = parseInt(price, 10); // Ensure amount is an integer

                 const optionDiv = document.createElement('div');
                 optionDiv.className = 'widget-dynamic-ticket-option';

                 const textP = document.createElement('p');
                 // Use innerHTML for bold/color formatting as in CSS
                 // Ensure price is valid before displaying FCFA
                 textP.innerHTML = `<font><strong>${escapeHtml(categoryName)}</strong> - ${isNaN(amount) ? 'Prix Inconnu' : `${escapeHtml(price)}F`}</font>`;

                 const button = document.createElement('button');
                 button.textContent = buttonText;
                 button.className = 'widget-dynamic-payment-button';
                 
                 // Disable button if price is not a valid number for payment (still allow 'Obtenir' if amount is 0?)
                 // Let's disable if amount is NaN or <= 0 for 'Payer', but allow amount = 0 for 'Obtenir'.
                 const isPaidCategoryWithInvalidPrice = !isFree && (isNaN(amount) || amount <= 0);
                 const isDisabled = isPaidCategoryWithInvalidPrice; // Disable only if paid category has invalid/zero price


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
                                     // syncAndDisplayOfferings() is called within initPayment's FedaPay callbacks or error handling,
                                     // or after the find/reserve loop finishes.
                                     // A final sync here ensures the UI updates after the whole process.
                                     // Pas besoin d'appeler sync ici, initPayment met à jour widgetOfferings directement
                                     // et la fonction de restauration le fait aussi.
                                 });
                        };
                     })(categoryName, amount, button); // Pass `button` element here
                 }


                 optionDiv.appendChild(textP);
                 optionDiv.appendChild(button);
                 optionsContainer.appendChild(optionDiv);
             } else {
                  // console.warn(`Widget: Category "${categoryName}" is not available or price is missing in offerings, skipping display.`); // Avoid excessive logging
             }
        }

        // --- Manage visibility based on whether displayable tickets were found ---
        // Always show the title section, search button, and direct link if createTicketOptions is called after successful DB init/sync
        if (ratesSection) ratesSection.style.display = 'block';
        if (ticketNotReceivedButton) ticketNotReceivedButton.style.display = 'block';
        if (directLinkContainer) directLinkContainer.style.display = 'block';


        if (offeringsFoundForDisplay) {
             optionsContainer.style.display = 'flex'; // Show options container
             payTicketButton.style.display = 'block'; // Show pay button
             loadingMessage.style.display = 'none'; // Hide loading message if options are shown
             // console.log("Widget: Ticket options displayed."); // Avoid excessive logging
        } else {
             // If no tickets found to display (either no categories, or all categories are empty/malformed)
             const checkStatusAndDisplayMessage = async () => {
                 // Re-check status to be absolutely sure, although syncAndDisplayOfferings should have already done this
                 const isActive = await checkSubscriptionStatus();
                 // Check if FedaPay Public API key is configured (payment form is possible)
                 const isFedaPayConfigured = fedapayApiKey && !fedapayApiKey.startsWith('<!--') && fedapayApiKey !== 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY';

                 if (!isActive) {
                     loadingMessage.textContent = 'Service de paiement de tickets indisponible. (Abonnement inactif)';
                 } else if (!isFedaPayConfigured && categories.length > 0) {
                      // Subscription is active, but FedaPay payment is NOT configured, but categories exist (implies manual distribution or other method)
                      loadingMessage.textContent = 'Paiement en ligne désactivé (clés FedaPay manquantes). Aucun ticket disponible par ce moyen.';
                 }
                 else if (categories.length > 0) {
                      // Subscription is active, FedaPay configured, but all categories are empty/malformed
                      loadingMessage.textContent = 'Aucun ticket disponible à la vente pour le moment dans les catégories configurées.';
                 } else {
                      // No categories found in widgetOfferings or sync failed previously
                      loadingMessage.textContent = 'Aucune catégorie de tickets configurée ou erreur de chargement des données.';
                 }
                  loadingMessage.style.display = 'block'; // Ensure message is visible
                  optionsContainer.style.display = 'none'; // Ensure options are hidden
                  payTicketButton.style.display = 'none'; // Hide pay button

             };
             // Execute message setting
             checkStatusAndDisplayMessage().catch(err => {
                  console.error("Widget Error: Failed to check status for message in createTicketOptions.", err);
                  loadingMessage.textContent = 'Erreur lors du chargement des tickets.';
                  loadingMessage.style.display = 'block';
                  optionsContainer.style.display = 'none';
                  payTicketButton.style.display = 'none';
                  // ratesSection, ticketNotReceivedButton, directLinkContainer remain 'block'
             });
              console.log("Widget: No ticket options found or displayed.");
        }
    }

    // MODIFIÉ : restoreTicket met maintenant à jour `widgetOfferings`
    async function restoreTicket(category, ticket) {
        if (!db || !adminUserId || adminUserId.startsWith('<!--') || !ticket || !ticket.user) { // Added adminUserId check
             console.warn("Widget: Cannot restore ticket, DB/adminId not available or ticket data missing/invalid.");
             return;
         }
         console.log(`Widget: Attempting to restore ticket for category: ${category}, user: ${ticket.user} for admin: ${adminUserId}`); // Use adminUserId in log
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
                 const alreadyExists = dataToUpdate.utilisateur.some((existingUser, index) => {
                     const existingPassword = (dataToUpdate.motDePasse && dataToUpdate.motDePasse.length > index) ? dataToUpdate.motDePasse[index] : '';
                     return existingUser === ticket.user && existingPassword === (ticket.password || '');
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
                // NOUVEAU : Mettre à jour la vue widgetOfferings pour rendre la catégorie de nouveau disponible
                const offeringRef = ref(db, `users-data/${adminUserId}/widgetOfferings/${category}/available`);
                await set(offeringRef, true); // Marquer comme disponible
                console.log(`Widget: Offering "${category}" marked as available.`);
                await syncAndDisplayOfferings(); // Rafraîchir l'UI rapidement
            } else if (result.error) {
                 console.error("Widget Error: Restore transaction failed:", result.error);
                 showWidgetNotification("Erreur Critique", `Impossible de restaurer le ticket ${ticket.user} (${category}). Contactez l'administrateur.`, false);
            } else {
                 console.log(`Widget: Restore transaction aborted (ticket likely already exists or initial data was null).`);
            }

         } catch (error) {
             console.error("Widget Error: Erreur générale lors de la restauration du ticket:", error);
             showWidgetNotification("Erreur Critique", `Une erreur est survenue lors de la tentative de restauration du ticket ${ticket.user} (${category}). Contactez l'administrateur.`, false);
         }
         // syncAndDisplayOfferings() est déjà appelée après la mise à jour de widgetOfferings
    }

    // Stores a successfully sold ticket in VendorsHistory under a specific vendor key (e.g., "Widget Vente en Ligne")
    // This function is called from the FedaPay onComplete callback OR free ticket logic.
    async function storeSaleInHistory(vendorName, ticket) {
        if (!db || !adminUserId || adminUserId.startsWith('<!--') || !vendorName || !ticket || !ticket.user || !ticket.category) { // Added adminUserId check
            console.warn("Widget: Cannot store sale, DB/adminId/vendorName/ticket data missing or invalid.");
            return;
        }
        console.log(`Widget: Storing sale in VendorsHistory (${adminUserId})/${vendorName}:`, ticket.user); // Use adminUserId in log and path
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
               transactionId: ticket.transactionId || null, // Example for FedaPay (FedaPay's transaction ID)
               paymentStatus: ticket.paymentStatus || 'completed', // Example for FedaPay
               transactionUserId: ticket.transactionUserId || null // Store the generated ID used in FedaPay description (Our internal ID)
           });
           console.log(`Widget: Sale stored successfully under "${vendorName}" for admin ${adminUserId}.`);
       } catch (error) {
           console.error(`Widget Error: Failed to store sale history under "${vendorName}":`, error);
           // Do not show user notification for this internal error, log it.
           // showWidgetNotification("Erreur", `Impossible de stocker l'historique de vente pour "${vendorName}".`, false);
       }
   }

   // --- Store sale in BalanceSales (for revenue tracking) ---
   // Called for BOTH paid and free tickets
    async function storeBalanceSale(ticket) {
        if (!db || !adminUserId || adminUserId.startsWith('<!--') || !ticket || ticket.price == null || !ticket.user) { // Added adminUserId check and price check
            console.warn("Widget: Cannot store balance sale, DB/adminId/data missing or incomplete/invalid.", ticket);
            return;
        }
        console.log(`Widget: Storing sale in BalanceSales (${adminUserId}) for user ${ticket.user}, amount ${ticket.price}, vendor ${ticket.vendor || 'Unknown'}`); // Use adminUserId in log and path
        try {
            const balanceSalesRef = ref(db, `users-data/${adminUserId}/BalanceSales`); // Use adminUserId for path
            const newSale = {
                user: ticket.user,
                password: ticket.password || '',
                price: parseFloat(ticket.price) || 0, // Stocke le prix numérique
                category: ticket.category || 'Unknown',
                vendor: ticket.vendor || 'Unknown', // Should be populated by initPayment or processSingleConnectedTicket
                soldAt: Date.now(), // Timestamp de l'opération
                status: 'approved', // Ajoute un statut 'approved' pour la balance (peut être 'free' pour tickets cadeau?)
                 // Let's keep 'approved' for now, distinction is by vendor/price=0
                 // Add payment specific details if available (for paid tickets)
                 transactionId: ticket.transactionId || null, // Example for FedaPay (FedaPay's transaction ID)
                 paymentStatus: ticket.paymentStatus || 'completed', // Example for FedaPay
                 transactionUserId: ticket.transactionUserId || null // Store the generated ID used in FedaPay description (Our internal ID)
            };
            await push(balanceSalesRef, newSale);
            console.log(`Widget: Balance sale stored successfully in BalanceSales (${adminUserId}).`);
        } catch (error) {
            console.error(`Widget Error: Failed to store balance sale:`, error);
            // Do not show user notification for this internal error, log it.
            // showWidgetNotification("Erreur", "Impossible d'enregistrer la vente pour votre solde.", false);
        }
    }

    // Stores a successfully sold ticket in TicketsVendus (Global history)
    // Called for BOTH paid and free tickets
    // Kept singular name storeTicketVendu for consistency with original
    async function storeTicketVendu(ticket) {
         if (!db || !adminUserId || adminUserId.startsWith('<!--') || !ticket || !ticket.user || !ticket.category || ticket.price == null) { // Added adminUserId check and price check
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
                transactionId: ticket.transactionId || null, // Example for FedaPay (FedaPay's transaction ID)
                paymentStatus: ticket.paymentStatus || 'completed', // Example for FedaPay
                transactionUserId: ticket.transactionUserId || null // Store the generated ID used in FedaPay description (Our internal ID)
            };
            await push(ticketsVendusRef, newSale);
            console.log("Widget: Ticket vendu stocké avec succès dans Firebase (TicketsVendus).");
        } catch (error) {
            console.error("Widget Error: Erreur lors du stockage du ticket vendu (TicketsVendus):", error);
            // Do not show user notification for this internal error, log it.
            // showWidgetNotification("Erreur", `Impossible de stocker le ticket dans l'historique global.`, false);
        }
    }

    // --- Store connected ticket username ---
    // This function is called by the login form handler when a user successfully logs into Mikrotik.
    // It logs the username to Firebase for processing by the admin dashboard.
    // NOTE: The login form submit listener in initializeWidget also calls this function on *attempted* login.
    // Consider if that initial log on attempt is necessary or if only successful login should be logged here.
    // The function name `storeConnectedTicket` implies a successful connection.
    // Kept as-is for parity with the code you provided earlier.
    // Ensure your actual login form handler in pay.html calls this function on successful login.
    /* This function is defined above near initializeWidget */


    // --- Local Storage Handling ---
    function storeTicketLocally(ticketData) {
        try {
            // Store a more complete ticket object, including price and category for display
            const ticketToStore = {
                user: ticketData.user,
                password: ticketData.password,
                price: ticketData.price, // Keep price as is (FCFA string or number)
                category: ticketData.category,
                // Optionally add transaction ID if needed for "Voir mon ticket"
                transactionId: ticketData.transactionId || null, // FedaPay transaction ID
                transactionUserId: ticketData.transactionUserId || null // Our internal ID
            };
            localStorage.setItem('storedTicket', JSON.stringify(ticketToStore)); // Use 'storedTicket' key for consistency with payer-widget
             console.log("Widget: Ticket stored locally:", ticketData.user);
        } catch (e) {
             console.error("Widget Error: Failed to store ticket locally:", e);
        } finally {
             updateButtonText(); // Update the main button text after potentially storing a ticket
        }
    }

    function removeStoredTicketLocally() {
         try {
            localStorage.removeItem('storedTicket'); // Use 'storedTicket' key
            console.log("Widget: Local ticket removed.");
         } catch (e) {
            console.error("Widget Error: Failed to remove local ticket:", e);
         } finally {
             updateButtonText(); // Update the main button text after removing the ticket
         }
    }

     // --- Free Ticket Eligibility ---
     // Checks if a free ticket can be obtained based on localStorage timestamp
     function canGetFreeTicket() {
        const lastFreeTicket = localStorage.getItem('lastFreeTicket');
        if (!lastFreeTicket) {
             console.log("Widget: No previous free ticket found. Eligible.");
             return true; // No record means they can get one
        }
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
        console.log(`Widget: Checking free ticket eligibility. Last ticket timestamp: ${lastTicketTimestamp} (${new Date(lastTicketTimestamp).toISOString()}), now: ${now.toISOString()}. Diff days: ${diffDays.toFixed(2)}. Allowed (>=7 days): ${allowed}`);
        return allowed;
    }

    // Sets the timestamp for the last free ticket obtained
    function setLastFreeTicketTimestamp() {
         try {
            localStorage.setItem('lastFreeTicket', Date.now().toString());
            console.log("Widget: Last free ticket timestamp updated.");
         } catch (e) {
             console.error("Widget Error: Failed to store free ticket timestamp:", e);
         }
    }

    // Loader functions (showLoader/hideLoader) - Modified to match payer-widget.js style
    // Use global loader if present, otherwise do nothing globally.
    const showLoader = (message = "Traitement...") => { // Added default message but not used in payer-style
        const loaderWrapper = document.getElementById('loaderWrapper'); // Check for global loader element
        if (loaderWrapper) {
            loaderWrapper.classList.add('active');
             // Note: Not updating text or disabling main button here to match payer-widget.js style
             // If you need text update, add back:
             // const loaderText = loaderWrapper.querySelector('.loader-text');
             // if (loaderText) {
             //     loaderText.textContent = message;
             // }
        }
        // Removed fallback to loadingMessage element
        // Removed disabling the main payTicketButton here
    };

    const hideLoader = () => {
        const loaderWrapper = document.getElementById('loaderWrapper');
        if (loaderWrapper) {
            loaderWrapper.classList.remove('active');
        }
        // Removed fallback to loadingMessage element
        // Removed re-enabling the main payTicketButton here
    };


    // --- initPayment function (Integrated FedaPay Logic) ---
    // Handles finding a unique ticket and initiating payment/distribution.
    // This function now incorporates the full logic from the second block provided by the user.
    window.initPayment = async function(category, amount) { // amount is passed from createTicketOptions
        console.log(`Widget: initPayment called for category: "${category}", amount: ${amount}`);

        // Basic checks
        if (!adminUserId || adminUserId.startsWith('<!--')) { // Added check for valid adminUserId
             hideLoader(); // Ensure loader is hidden
             showWidgetNotification("Erreur Configuration", "ID Administrateur manquant ou invalide. Contactez l'administrateur.", false);
             console.error("Widget Critical Error: Admin User ID is missing or invalid.");
             return;
        }
        if (typeof FedaPay === 'undefined' || !FedaPay.init) {
            hideLoader();
            showWidgetNotification("Erreur", "Service FedaPay non chargé. Vérifiez votre connexion.", false);
            console.error("Widget Critical Error: FedaPay SDK not available.");
            return;
        }
        // Check injected Public API key
        if (!fedapayApiKey || fedapayApiKey.startsWith('<!--') || fedapayApiKey === 'pk_live_YOUR_FEDAPAY_PUBLIC_KEY') {
             hideLoader();
             showWidgetNotification("Erreur de configuration", "La clé API Publique FedaPay est manquante ou invalide. Contactez l'administrateur.", false);
             console.error("Widget Critical Error: FedaPay Public API key is missing or default.");
             return;
        }
         if (!db || !runTransaction || !push || !ref || !set) { // Ensure DB and necessary functions are available
             hideLoader();
             showWidgetNotification("Erreur", "Connexion à la base de données non établie ou composants manquants.", false);
             console.error("Widget Critical Error: Firebase DB or required functions not initialized.");
             return;
         }


        showLoader(); // Show loader while reserving ticket and waiting for FedaPay init

        let reservedTicketData = null; // This will hold the specific ticket {user, password, price, category, vendor} found and reserved
        let findAttempt = 0;
        let findSuccessful = false;
        const ticketsTotalCategoryRef = ref(db, `users-data/${adminUserId}/TicketsTotal/${category}`);
        const vendorId = category.toLowerCase().includes('ticket cadeau') || category.toLowerCase().includes('gratuit') ? "Produit offert" : "Vente en Ligne"; // Determine vendor name early


        // --- Handle Free Tickets Eligibility First (before reservation loop) ---
        const isFreeCategory = category.toLowerCase().includes('ticket cadeau') || category.toLowerCase().includes('gratuit');

        if (isFreeCategory) {
             console.log("Widget: Checking free ticket eligibility for category:", category);
             if (!canGetFreeTicket()) {
                 hideLoader();
                 showWidgetNotification("Non disponible", "Vous avez déjà obtenu un ticket cadeau récemment. Attendez 7 jours avant de pouvoir en obtenir un autre.", false);
                 console.log("Widget: Free ticket eligibility failed.");
                 // No reservation occurred, so no need to restore.
                 // syncAndDisplayOfferings() will be called by the button's finally block.
                 return; // Abort process if not eligible
             }
             console.log("Widget: Free ticket eligibility passed.");
             // If eligible, PROCEED to the reservation logic.


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

                // MODIFIÉ : Mettre à jour `widgetOfferings` si la catégorie devient vide
               if (updatedData.utilisateur.length === 0) {
                    console.log(`Widget: [Transaction] Category "${category}" is now empty, preparing to remove node.`);
                    // Mettre à jour `widgetOfferings` en dehors de la transaction Firebase (Firebase n'autorise pas les side-effects)
                    // C'est déclenché APRÈS que la transaction est confirmée.
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

                 // NOUVEAU : Si la transaction a vidé la catégorie (en retournant null)
                 if (transactionResult.snapshot.val() === null) { // Check if the node was removed by the transaction
                    console.log(`Widget: Category "${category}" is now empty (via free ticket), updating offerings.`);
                    const offeringRef = ref(db, `users-data/${adminUserId}/widgetOfferings/${category}/available`);
                    await set(offeringRef, false); // Marquer comme indisponible
                    console.log(`Widget: Offering "${category}" marked as unavailable.`);
                 }

                 // Mark the timestamp of the last free ticket obtained locally
                setLastFreeTicketTimestamp();

                // --- Store Sale Data for Free Tickets ---
                // Free tickets don't go through FedaPay, so we store them directly here.
                // We *could* generate a transaction ID for consistency if needed, but for free, it's often omitted.
                const freeTicketDetails = { ...reservedTicketData, transactionId: null, paymentStatus: 'free', transactionUserId: null }; // No transactionUserId for free tickets

                await storeBalanceSale(freeTicketDetails); // Stocker dans BalanceSales (price should be 0)
                await storeSaleInHistory(freeTicketDetails.vendor, freeTicketDetails); // Stocker dans VendorsHistory (Gratuit)
                await storeTicketVendu(freeTicketDetails); // Stocker dans TicketsVendus (global)

                // Store the ticket locally in the user's browser for display/auto-login
                storeTicketLocally(freeTicketDetails);

                // Show success notification with ticket details
                showWidgetNotification("Ticket cadeau obtenu", "Félicitations ! Votre ticket est prêt.", true, freeTicketDetails);

                await syncAndDisplayOfferings(); // Rafraîchir l'UI rapidement après l'achat gratuit

             } else if (!transactionResult.committed && transactionResult.snapshot && transactionResult.snapshot.exists()) { // Check if snapshot exists and transaction didn't commit
                // Transaction aborted (ticket taken by someone else) or failed for other reasons but node exists
                console.warn("Widget: Free ticket transaction aborted (ticket taken?). Syncing UI.");
                 showWidgetNotification("Indisponible", "Ce ticket cadeau vient d'être pris. Liste mise à jour.", false);
                 await syncAndDisplayOfferings(); // Re-sync to show updated stock
             }
            else if (transactionResult.error) {
               console.error("Widget Error: Transaction failed for free ticket:", transactionResult.error);
               showWidgetNotification("Erreur Système", "Erreur lors de la transaction du ticket cadeau. Réessayez.", false);
            } else {
                 // Transaction committed successfully but candidateTicketDetails is null (means category was empty initially)
                 // Or transaction aborted and snapshot did *not* exist (category was empty)
                 console.log("Widget: No tickets found for free category during transaction.");
                  showWidgetNotification("Indisponible", `Aucun ticket disponible pour "${category}" pour le moment.`, false);
                  await syncAndDisplayOfferings(); // Re-sync au cas où la catégorie serait devenue vide
            }
            return; // Exit initPayment function for free tickets
        }


        // --- Paid Ticket Logic (Reservation + FedaPay) ---

         // Ticket reservation loop (only for paid tickets)
         // Use showTooltip for the inner reservation loop while loader is also visible
         // showLoader("Recherche d'un ticket disponible..."); // Not updating loader text in payer-style

        while (findAttempt < MAX_SALE_RETRIES && !findSuccessful) { // Using MAX_SALE_RETRIES for reservation attempts
            findAttempt++;
            console.log(`Widget: Attempt ${findAttempt}/${MAX_SALE_RETRIES} to find and reserve unique ticket for category: "${category}"`);
            if (findAttempt > 1) {
                 showTooltip(`Ticket déjà vendu, recherche du suivant... (Tentative ${findAttempt})`);
                 await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between attempts
            }

            // 1. Get current state of TotalTickets for the category (using a simple get before transaction)
            // This snapshot gives us the ticket details *to check*, but the transaction guarantees atomic removal.
            let currentTicketsDataSnapshot;
            try {
                currentTicketsDataSnapshot = await get(ticketsTotalCategoryRef);
            } catch (dbError) {
                 hideTooltip(); // Hide inner tooltip
                 hideLoader(); // Hide main loader
                 console.error(`Widget Error: Failed to get TotalTickets before transaction (attempt ${findAttempt}) for admin ${adminUserId}:`, dbError);
                 showWidgetNotification("Erreur Base de Données", "Erreur de lecture du stock avant réservation.", false);
                 // syncAndDisplayOfferings() will be called by the button's finally block.
                 return; // Stop on critical DB error before transaction loop
            }


            const currentTicketsData = currentTicketsDataSnapshot.val();

            if (!currentTicketsData || !Array.isArray(currentTicketsData.utilisateur) || currentTicketsData.utilisateur.length === 0) {
                console.log(`Widget: No more tickets in category "${category}" for admin ${adminUserId} during search (attempt ${findAttempt}).`);
                // NOUVEAU: Mettre à jour la vue widgetOfferings si la catégorie est vide
                const offeringRef = ref(db, `users-data/${adminUserId}/widgetOfferings/${category}/available`);
                await set(offeringRef, false); // Marquer comme indisponible
                console.log(`Widget: Offering "${category}" marked as unavailable as it's empty.`);
                await syncAndDisplayOfferings(); // Rafraîchir l'UI
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

                     // MODIFIÉ : Mettre à jour `widgetOfferings` si la catégorie devient vide
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
                // NOUVEAU : Si la transaction a vidé la catégorie (en retournant null)
                if (transactionResult.snapshot.val() === null) { // Check if the node was removed by the transaction
                    console.log(`Widget: Category "${category}" is now empty (via paid ticket), updating offerings.`);
                    const offeringRef = ref(db, `users-data/${adminUserId}/widgetOfferings/${category}/available`);
                    await set(offeringRef, false); // Marquer comme indisponible
                    console.log(`Widget: Offering "${category}" marked as unavailable.`);
                }

                if (!isDuplicate) {
                    // We successfully removed a non-duplicate ticket
                    reservedTicketData = candidateTicketDetails; // This is the ticket we reserved
                    findSuccessful = true; // Mark success to exit the loop
                    console.log(`Widget: Unique ticket reserved via transaction: ${reservedTicketData.user}`);
                } else {
                     // We successfully removed a duplicate ticket. Loop will continue to find the next one.
                     console.log(`Widget: Duplicate ticket removed via transaction. Looping to check next ticket.`);
                     // No need to syncAndDisplayOfferings() here, the next loop iteration's initial 'get' will reflect the change.
                }

            } else if (transactionResult.error) {
                // Transaction failed (e.g., network error, permissions)
                 console.error("Widget Error: Transaction failed:", transactionResult.error);
                 // The loop will continue if attempts < MAX_SALE_RETRIES
            } else {
                 // Transaction aborted (likely because the first ticket changed)
                 console.warn("Widget: Transaction aborted (first ticket changed concurrently?). Retrying...");
                 // The loop will continue if attempts < MAX_SALE_RETRIES
            }

             // Check if we should continue looping
             if (!findSuccessful && findAttempt >= MAX_SALE_RETRIES) {
                  console.warn(`Widget: Max reservation attempts (${MAX_SALE_RETRIES}) reached without finding and reserving a unique ticket.`);
                  break; // Exit loop
             }

        } // --- End of while loop for finding/reserving ticket ---

        hideTooltip(); // Hide searching message after loop ends

        // --- Check if a ticket was successfully reserved ---
        if (!reservedTicketData) {
            // If the loop finished but no ticket was reserved
            hideLoader(); // Hide loader if no unique ticket was found after retries
            const msg = findAttempt >= MAX_SALE_RETRIES
                ? `Impossible de trouver un ticket unique pour la catégorie ${category} après plusieurs tentatives. Contactez l'administrateur.`
                : `Désolé, aucun ticket disponible à la vente pour la catégorie : ${category}.`;
             showWidgetNotification(findAttempt >= MAX_SALE_RETRIES ? "Erreur Stock" : "Indisponible", msg, false);
             await syncAndDisplayOfferings(); // Re-sync to show updated stock
            return; // Stop the payment process
        }
        // --- Unique paid ticket is now in reservedTicketData and removed from stock ---


        // --- NOUVEAU : Générer l'ID unique et stocker TOUTES les données du ticket ---
        let transactionUserId = null; // Variable to store the generated ID
        try {
             console.log(`Widget: Generating unique ID and storing ticket details (${reservedTicketData.user}) in TransactionUserMap...`);
             // Ensure adminUserId is valid before attempting to store data
             if (!adminUserId || adminUserId.startsWith('<!--')) {
                  throw new Error("Cannot generate unique ID and store ticket data, Admin ID is invalid.");
             }
             const userMapRef = ref(db, `users-data/${adminUserId}/TransactionUserMap`); // Reference to the mapping node
             const newUserMapRef = push(userMapRef); // Create a new unique key
             transactionUserId = newUserMapRef.key; // Get the unique key
             // Store the entire reservedTicketData object plus a timestamp
             await set(newUserMapRef, {
                 ...reservedTicketData, // Spread all properties from reservedTicketData (user, password, price, category, vendor)
                 timestamp: Date.now() // Add the timestamp
             });
             console.log(`Widget: Unique ID generated: ${transactionUserId}. Full ticket details stored under this ID.`);

        } catch (error) {
             console.error("Widget Error: Failed to create unique ID entry and store ticket details in TransactionUserMap:", error);
             hideLoader(); // Ensure loader is hidden on error
             showWidgetNotification("Erreur Système", "Erreur lors de la préparation de la transaction. Le ticket sera restauré. Réessayez.", false);
             // CRITICAL: If we fail to create the ID mapping, we CANNOT proceed with payment, as we won't know which user the payment was for.
             // Restore the ticket we just reserved.
             await restoreTicket(category, reservedTicketData);
             // syncAndDisplayOfferings() is called by the button's finally block.
             return; // Abort payment process
        }
        // --- Fin NOUVEAU ---


        // --- Proceed with the reserved ticket and generated ID for FedaPay Payment ---
        console.log("Widget: Ticket reserved, unique ID and details stored. Initiating FedaPay payment...");
        // The reservedTicketData object already contains all necessary info (user, pass, price, category, vendor)

        // Use the generated unique ID as the description
        const description = `${transactionUserId}`; // This ID links the FedaPay transaction back to our stored ticket data in Firebase

        // Ensure amount is used for FedaPay initiation, even if ticket.price is slightly different
        // (assuming amount passed to initPayment from UI button is the intended payment amount)
        // If ticket.price from DB is the definitive price, use reservedTicketData.price here.
        // Let's use the amount from the button click for payment amount.
        const paymentAmount = amount; // Or use reservedTicketData.price if DB price is authoritative

         if (paymentAmount == null || isNaN(paymentAmount) || paymentAmount <= 0) {
             hideLoader(); // Ensure loader is hidden if amount is invalid
             console.error(`Widget Error: Montant FedaPay invalide (${paymentAmount}) pour paiement.`);
             showWidgetNotification("Erreur Paiement", "Montant invalide pour le paiement.", false);
             // Need to restore the ticket as we cannot proceed with payment
             // Also consider cleaning up the TransactionUserMap entry? Not strictly necessary,
             // as it can serve as a log of attempted payments, but could be added.
             await restoreTicket(category, reservedTicketData);
             // syncAndDisplayOfferings() is called by the button's finally block.
             return;
         }

        const fedaPayInstance = FedaPay.init({
            public_key: fedapayApiKey, // Use the injected/configured FedaPay Public Key
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
                        // Add other relevant response fields if needed
                    };
                    showWidgetNotification("Paiement réussi", `Merci pour votre achat ! Votre ticket est prêt.`, true, soldTicketDetails);
                     console.log("Widget: Payment successful. Storing sale...");
                     // Ensure adminUserId is valid before storing
                     if (db && adminUserId && !adminUserId.startsWith('<!--')) {
                         // Store in all relevant locations
                         await storeBalanceSale(soldTicketDetails); // Stocker dans BalanceSales
                         await storeSaleInHistory(soldTicketDetails.vendor, soldTicketDetails); // Stocker dans VendorsHistory (Payant)
                         await storeTicketVendu(soldTicketDetails); // Stocker dans TicketsVendus (global)

                         // Store ticket locally for "Voir mon ticket"
                         storeTicketLocally(soldTicketDetails);
                         console.log("Widget: Ticket stored successfully after payment.");
                     } else {
                         console.error("Widget Error: DB or adminId invalid, cannot store sale data after successful payment!");
                         showWidgetNotification("Erreur Système", "Paiement réussi mais impossible d'enregistrer la vente. Contactez l'administrateur.", false);
                         // The user has paid, DO NOT restore the ticket. It might be lost in the DB state, but the payment is confirmed via FedaPay ID.
                         // The admin can manually recover the ticket using the FedaPay Transaction ID and internal TransactionUserMap ID.
                         // Store the ticket locally anyway so the user can connect if needed.
                         storeTicketLocally(soldTicketDetails);
                     }
                    await syncAndDisplayOfferings(); // Rafraîchir l'UI rapidement après l'achat payant

                } else {
                    // Payment attempted but not approved or other status
                    // FedaPay statuses might include PENDING, FAILED, etc.
                    console.warn(`Widget: Payment status is neither DIALOG_DISMISSED nor CHECKOUT_COMPLETED via onComplete: ${response.status || 'unknown'}. Transaction ID: ${response.transaction?.id || 'N/A'}.`);
                    showWidgetNotification("Paiement non confirmé", `Statut: ${response.status || 'inconnu'}. Ticket non délivré. Si vous pensez avoir été débité, contactez le support.`, false);
                    // Restore the ticket in case of ambiguous or failed statuses where we didn't get PAID
                    if (reservedTicketData && db && adminUserId && !adminUserId.startsWith('<!--')) { // Double check ticket data and DB/adminId exists
                         await restoreTicket(category, reservedTicketData); // Pass the specific reserved ticket
                         // Note: The TransactionUserMap entry remains.
                         // Optionally, log the transaction in TicketsVendus/BalanceSales with the specific status
                         // await storeTicketVendu({...reservedTicketData, paymentStatus: response.status || 'unknown', transactionId: response.transaction?.id || null, transactionUserId: transactionUserId});
                         // await storeBalanceSale({...reservedTicketData, paymentStatus: response.status || 'unknown', transactionId: response.transaction?.id || null, transactionUserId: transactionUserId});
                    } else {
                       console.error("Widget Error: Non-COMPLETED/DISMISSED status received but no reserved ticket data or valid DB/adminId found!");
                    }
                    await syncAndDisplayOfferings(); // Re-sync si le paiement n'est pas confirmé
                }
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
                  if (reservedTicketData && db && adminUserId && !adminUserId.startsWith('<!--')) { // Double check ticket data and DB/adminId exists
                     await restoreTicket(category, reservedTicketData); // Pass the specific reserved ticket
                      // Note: The TransactionUserMap entry remains.
                      // Optionally, log the failed transaction in TicketsVendus/BalanceSales with status 'error'
                      // await storeTicketVendu({...reservedTicketData, paymentStatus: 'error', transactionId: null, transactionUserId: transactionUserId}); // No FedaPay ID on error
                      // await storeBalanceSale({...reservedTicketData, paymentStatus: 'error', transactionId: null, transactionUserId: transactionUserId}); // Maybe not needed for balance on error
                  } else {
                     console.error("Widget Error: onError received but no reserved ticket data or valid DB/adminId found!");
                  }
                 await syncAndDisplayOfferings(); // Re-sync en cas d'erreur
              } // --- End of onError ---
        }); // --- End of FedaPay.init ---

        try {
             // showLoader("Ouverture du portail de paiement..."); // Not updating loader text in payer-style
            fedaPayInstance.open();
        } catch (openError) {
            console.error("Widget Error: Failed to open FedaPay dialog:", openError);
             hideLoader(); // Hide loader if opening fails
            showWidgetNotification("Erreur de paiement", `Impossible d'ouvrir la fenêtre de paiement: ${openError.message}.`, false);
            // If opening fails *after* reservation and TransactionUserMap entry creation, restore the ticket
            if (reservedTicketData && db && adminUserId && !adminUserId.startsWith('<!--')) { // Double check ticket data and DB/adminId exists
                 await restoreTicket(category, reservedTicketData);
                 // Note: The TransactionUserMap entry remains.
            } else {
                console.error("Widget Error: Open FedaPay dialog failed but no reserved ticket data or valid DB/adminId found!");
            }
             await syncAndDisplayOfferings(); // Re-sync en cas d'échec d'ouverture
        }
    }; // --- End of initPayment ---


    // --- Auto-Login Function (Replicating login.html behaviour) ---
    window.autoLogin = function(username, password) { // Make sure this is globally available
        console.log(`Fedapay Widget: Attempting auto-login for ${username}...`);

        const loginForm = document.querySelector('form[name="login"]');

        if (!loginForm) {
            console.error("Fedapay Widget Error: Could not find the main login form (form[name='login']) on the page. Auto-login failed.");
            showWidgetNotification("Erreur Connexion Auto", "Formulaire de connexion introuvable.", false);
            return;
        }

        try {
            const usernameInput = loginForm.elements['username'];
            const passwordInput = loginForm.elements['password'];

             if (!usernameInput) {
                console.error("Fedapay Widget Error: Could not find username input field within the found login form. Auto-login failed.");
                showWidgetNotification("Erreur Connexion Auto", "Champ 'username' manquant dans le formulaire.", false);
                return;
            }

            usernameInput.value = username;
             if (passwordInput && password) {
                 passwordInput.value = password;
             } else if (passwordInput && !password) {
                 passwordInput.value = '';
             }

            console.log(`Fedapay Widget: Filled login form for ${username}. Submitting...`);

            // IMPORTANT: Use doLogin() if your login form uses Mikrotik's challenge/response MD5 hashing
            if (typeof doLogin === 'function') {
                console.log("Fedapay Widget: doLogin() function found. Using doLogin() for submission.");
                doLogin(); // Use the Mikrotik hashing function if available
            } else {
                console.log("Fedapay Widget: doLogin() function not found. Using form.submit().");
                // Fallback to direct form submission (might not work if MD5 is required)
                loginForm.submit();
            }


        } catch (error) {
            console.error("Fedapay Widget Error: An unexpected error occurred while attempting to fill or submit the existing login form.", error);
             showWidgetNotification("Erreur Système", "Une erreur interne est survenue lors de la connexion automatique.", false);
        }
    }

 // --- UI Functions ---
    // Utility to show tooltip message
    function showTooltip(message, duration = 2500) {
        // Assume tooltip element exists in the HTML template
        tooltip = tooltip || document.querySelector('#widget-tooltip'); // Ensure tooltip is queried if not already
        if (!tooltip) {
             console.warn("Widget: Tooltip element not found.");
            return;
        }
        tooltip.textContent = message;
        tooltip.style.opacity = '1';
        tooltip.style.display = 'block';
        setTimeout(() => {
            tooltip.style.opacity = '0';
             setTimeout(() => { if(tooltip) tooltip.style.display = 'none'; }, 300); // Add null check for tooltip
        }, duration);
    }
    function hideTooltip() {
         tooltip = tooltip || document.querySelector('#widget-tooltip'); // Ensure tooltip is queried
        if (!tooltip) return;
        tooltip.style.opacity = '0';
        setTimeout(() => { if(tooltip) tooltip.style.display = 'none'; }, 300); // Add null check
    }


    // Show a notification popup within the widget container
    // MODIFIED showWidgetNotification to ADD auto-login and delete buttons BACK for ticket purchase messages
    window.showWidgetNotification = function(title, message, isTicketPurchase = false, ticket = null) {
        if (!notificationPopup || !notificationTitle || !notificationMessage) {
            console.error("Widget Error: Notification elements not found for display.");
            return;
        }

        notificationTitle.textContent = title;
        notificationMessage.innerHTML = ''; // Clear previous message content

        // Remove any dynamically added buttons from previous notifications
        // Keep this line to ensure old buttons are cleared if the function is called multiple times rapidly
        const existingButtons = notificationPopup.querySelectorAll('.widget-connect-button, .widget-close-button, .widget-delete-button');
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


             // Add Connect button
            const connectButton = document.createElement('button');
            connectButton.className = 'widget-connect-button'; connectButton.textContent = 'Se connecter';
             // DÉBUT DES MODIFICATIONS POUR LE SCROLL ET AUTO-LOGIN EN DERNIER
            connectButton.onclick = async () => {
                // 1. Exécuter TOUTES les opérations existantes en premier
                // (Note: storeConnectedTicket est async, mais window.autoLogin et hideWidgetNotification sont sync.)
                // L'ordre est maintenu comme avant.
                if (db && adminUserId && !adminUserId.startsWith('<!--')) {
                    await storeConnectedTicket(ticket.user); // Log connection attempt
                } else {
                    console.warn("Widget: DB or adminId invalid, cannot store connected ticket username on Connect click.");
                }
                window.autoLogin(ticket.user, ticket.password); // Attempt Mikrotik login using the global autoLogin function
                hideWidgetNotification(); // Hide the notification modal

                // 2. Ajouter la nouvelle logique après un court délai pour permettre aux opérations précédentes de s'initier
                // et potentiellement au navigateur de commencer le processus de connexion Mikrotik si autoLogin soumet directement.
                setTimeout(() => {
                    const loginSection = document.querySelector('.login-section');
                    if (loginSection) {
                        console.log("Widget: Scrolling to login section for auto-fill and submit...");
                        loginSection.scrollIntoView({ behavior: 'smooth', block: 'center' }); // block: 'center' peut aider à centrer la section

                        // Un deuxième délai pour que le défilement se termine AVANT de tenter de remplir et soumettre le formulaire
                        // (Si autoLogin a déjà soumi, cela n'aura pas d'impact, mais c'est pour le cas où il ne soumet pas immédiatement)
                        // Note: Dans votre configuration actuelle, window.autoLogin soumet déjà le formulaire.
                        // Cette partie pourrait être redondante si Mikrotik redirige immédiatement.
                        // Si Mikrotik attend le click, alors ces lignes seront utiles.
                        setTimeout(() => {
                            const loginForm = document.querySelector('form[name="login"]');
                            if (loginForm) {
                                const usernameInput = loginForm.elements['username'];
                                const passwordInput = loginForm.elements['password'];

                                if (usernameInput) usernameInput.value = ticket.user;
                                if (passwordInput) passwordInput.value = ticket.password || '';

                                console.log(`Widget: Login fields filled for ${ticket.user}.`);

                                // Si la fonction doLogin de Mikrotik est présente, l'appeler.
                                // Sinon, soumettre le formulaire directement.
                                // NOTE: autoLogin a déjà tenté de le faire. Cette partie est pour la "visibilité"
                                // de l'action sur la page si l'autoLogin initial n'a pas redirigé.
                                // SI l'autoLogin redirige TOUJOURS immédiatement, cette partie ne sera jamais vue.
                                if (typeof doLogin === 'function') {
                                    console.log("Widget: doLogin() found, attempting to submit after scroll.");
                                    doLogin();
                                } else {
                                    console.log("Widget: doLogin() not found, submitting form directly after scroll.");
                                    loginForm.submit();
                                }
                            } else {
                                console.warn("Widget: Login form not found after scroll, cannot fill/submit.");
                            }
                        }, 700); // Délai après le défilement (peut être ajusté)
                    } else {
                        console.warn("Widget: Login section (.login-section) not found for scrolling.");
                    }
                }, 100); // Petit délai initial pour permettre aux actions précédentes de se déclencher
            };
            // FIN DES MODIFICATIONS
             notificationPopup.appendChild(connectButton);

             // Add Delete button (for local storage)
             const deleteButton = document.createElement('button');
             deleteButton.className = 'widget-delete-button'; deleteButton.textContent = 'Supprimer'; // Updated text
             deleteButton.onclick = () => {
                 removeStoredTicketLocally(); // Remove ticket from local storage
                 hideWidgetNotification(); // Hide this notification
                 showWidgetNotification("Supprimé", "Ticket local supprimé de ce navigateur.", false); // Show confirmation (not a ticket purchase notification itself)
             };
             notificationPopup.appendChild(deleteButton);


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
        if (title.toLowerCase().includes('erreur') || title.toLowerCase().includes('indisponible') || title.toLowerCase().includes('annulé') || title.toLowerCase().includes('non confirmé') || title.toLowerCase().includes('impossible') || title.toLowerCase().includes('avertissement') || title.toLowerCase().includes('échec')) {
             notificationPopup.classList.add('error');
        } else {
             notificationPopup.classList.remove('error');
        }


        // Display the popup
        notificationPopup.style.display = 'block';
    }




     // Hide the notification popup
    window.hideWidgetNotification = function() { // Make sure this is globally available
         if(notificationPopup) {
             notificationPopup.style.display = 'none';
             notificationPopup.classList.remove('error'); // Remove error class
             // Optional: Clear message content and remove dynamic buttons when hidden
             // This prevents old content/buttons from flashing if the modal is reopened quickly.
             // notificationTitle.textContent = '';
             // notificationMessage.innerHTML = '';
             // const dynamicButtons = notificationPopup.querySelectorAll('.widget-connect-button, .widget-close-button, .widget-delete-button');
             // dynamicButtons.forEach(button => button.remove());
         }
    }

    // Reads the locally stored ticket and shows the notification
    function showStoredTicketNotification() {
        const storedTicketItem = localStorage.getItem('storedTicket'); // Use 'storedTicket' key
        if (storedTicketItem) {
            try {
                const ticket = JSON.parse(storedTicketItem);
                // Validate the parsed ticket object
                // Ensure essential properties exist, not just user. Added checks for password and category.
                if (ticket && typeof ticket === 'object' && ticket.user && ticket.password !== undefined && ticket.category !== undefined) {
                    console.log("Widget: Showing stored ticket:", ticket.user);
                    // Pass the parsed ticket object directly to showWidgetNotification
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
        const storedTicket = localStorage.getItem('storedTicket'); // Use 'storedTicket' key
        payTicketButton.textContent = storedTicket ? 'Voir mon ticket' : 'Payer un ticket';
         // console.log("Widget: Main button text updated."); // Avoid excessive logging
    }

    // Handler for the main widget button click
    function handlePayTicketButtonClick() {
        const storedTicketItem = localStorage.getItem('storedTicket'); // Use 'storedTicket' key
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

    // --- NEW "Ticket Not Received" Search Feature Logic ---

     // Show the search modal
    function showSearchModal() {
        if (!searchModal) {
            console.error("Widget Error: Search modal element not found.");
            showWidgetNotification("Erreur", "Erreur interne du widget. Veuillez rafraîchir.", false);
            return;
        }
         // Clear previous state
         searchInput.value = '';
         searchMessage.textContent = '';
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

    // Handle the search button click
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


        if (!db || !adminUserId || adminUserId.startsWith('<!--')) {
            displaySearchMessage("Erreur système: Configuration widget incomplète (DB/Admin ID).", 'error');
            console.error("Widget Error: DB or Admin ID missing for search.");
            searchLoader.style.display = 'none';
            searchButton.disabled = false;
            return;
        }

         // === MODIFICATION SOLUTION 1 : Chargement de la clé privée à la demande ===
         // Si la clé n'est pas déjà en cache, on la récupère maintenant.
         if (!fetchedPrivateApiKey) {
             console.log("Widget: Private API Key not cached, attempting to fetch for search...");
             await fetchPrivateApiKey(); // Tente de récupérer la clé.
         }

         // Vérifie si la clé a bien été récupérée après la tentative.
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
            // L'URL de l'API FedaPay pour rechercher les transactions
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

            // Rechercher dans la liste retournée celle qui correspond EXACTEMENT à la clé saisie par l'utilisateur.
            const foundTransaction = transactions.find(tx => tx.transaction_key === transactionKey);

            if (!foundTransaction) {
                // Ce cas peut arriver si l'API FedaPay retourne une liste (non vide),
                // mais qu'aucune transaction dans cette liste n'a la transaction_key exacte saisie.
                 displaySearchMessage("Id de transaction non trouvée.", 'error');
                 console.warn(`Widget: Transaction with key "${transactionKey}" not found in the returned list.`);
                 searchLoader.style.display = 'none';
                 searchButton.disabled = false;
                 return; // Arrêter le processus ici
            }


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
            const userMapRef = ref(db, `users-data/${adminUserId}/TransactionUserMap/${internalTransactionUserId}`);
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
                showWidgetNotification("Ticket trouvé!", "Voici les détails de votre ticket.", true, foundTicket);

            } else {
                displaySearchMessage("Ticket introuvable dans notre base de données avec cet ID. Contactez l'administrateur.", 'error');
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

    // Helper to display messages in the search modal
    function displaySearchMessage(message, type = 'info') {
        if (searchMessage) {
            searchMessage.textContent = message;
            searchMessage.className = `widget-search-message ${type}`;
        }
    }


    // --- Auto-Initialization Trigger ---
    // Ensures the widget initializes after the DOM is fully loaded.
    // This assumes the script tag is either deferred or placed at the end of the body.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeWidget);
    } else {
        initializeWidget();
    }

    // --- Make functions globally accessible if needed by the main page ---
    // This is necessary if the main page (pay.html) calls these functions (e.g., from Mikrotik variables)
    window.showWidgetNotification = showWidgetNotification;
    window.hideWidgetNotification = hideWidgetNotification;
    window.autoLogin = autoLogin;
    window.initPayment = initPayment; // Although typically called by button handlers, make it global
    // storeConnectedTicket might be called by the login form handler outside this widget
    window.storeConnectedTicket = storeConnectedTicket;
    // storeLoginTicket might also be called by the login form handler (already made global above)
    // window.storeLoginTicket = storeLoginTicket; // Already defined above

    // Expose new functions if needed globally (less likely, but possible)
    // window.showSearchModal = showSearchModal; // Uncomment if you need to trigger search modal from outside
    // window.hideSearchModal = hideSearchModal; // Uncomment if you need to hide search modal from outside


})(); // End of IIFE
