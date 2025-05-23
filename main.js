const Apify = require('apify');

Apify.main(async () => {
    console.log('Starting email scraper...');
    
    // Get input from user
    const input = await Apify.getInput();
    const { urls, url, waitForContent = 3 } = input;
    
    // Validate input
    if (!urls && !url) {
        throw new Error('Please provide either "urls" array or "url" string');
    }
    
    if (urls && url) {
        throw new Error('Please provide either "urls" OR "url", not both');
    }
    
    // Convert to array for consistent processing
    const urlsToProcess = urls || [url];
    console.log(`Processing ${urlsToProcess.length} URLs`);
    
    const results = [];
    
    // Email regex patterns
    const emailPatterns = [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,})/g
    ];
    
    // Create crawler
    const crawler = new Apify.PlaywrightCrawler({
        maxRequestsPerCrawl: urlsToProcess.length,
        requestHandler: async ({ page, request }) => {
            console.log(`Processing: ${request.url}`);
            
            try {
                // Wait for page to load completely
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(waitForContent * 1000);
                
                // Get page content
                const content = await page.content();
                const textContent = await page.textContent('body');
                
                // Extract emails
                const emails = new Set();
                
                // Method 1: Search in HTML content
                emailPatterns.forEach(pattern => {
                    const matches = content.match(pattern) || [];
                    matches.forEach(email => {
                        const cleanEmail = email.replace('mailto:', '');
                        if (isValidEmail(cleanEmail)) {
                            emails.add(cleanEmail);
                        }
                    });
                });
                
                // Method 2: Search in visible text
                emailPatterns.forEach(pattern => {
                    const matches = textContent.match(pattern) || [];
                    matches.forEach(email => {
                        const cleanEmail = email.replace('mailto:', '');
                        if (isValidEmail(cleanEmail)) {
                            emails.add(cleanEmail);
                        }
                    });
                });
                
                // Filter and clean emails
                const emailArray = Array.from(emails).filter(email => 
                    isValidEmail(email) && !isExcludedEmail(email)
                );
                
                console.log(`Found ${emailArray.length} valid emails`);
                
                // Store result
                results.push({
                    url: request.url,
                    emails: emailArray.length > 0 ? emailArray : ['__NO_EMAILS_FOUND__'],
                    timestamp: new Date().toISOString(),
                    totalEmailsFound: emailArray.length
                });
                
            } catch (error) {
                console.error(`Error processing ${request.url}:`, error.message);
                results.push({
                    url: request.url,
                    emails: ['__ERROR_OR_TIMEOUT__'],
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        },
        
        // Handle failed requests
        failedRequestHandler: async ({ request }) => {
            console.log(`Failed to process: ${request.url}`);
            results.push({
                url: request.url,
                emails: ['__ERROR_OR_TIMEOUT__'],
                error: 'Request failed',
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // Add URLs to crawler (no crawling, just exact URLs)
    await crawler.addRequests(urlsToProcess.map(url => ({ url })));
    
    // Run the crawler
    await crawler.run();
    
    // Save results to Apify dataset
    await Apify.pushData(results);
    
    console.log(`Scraping completed. Processed ${results.length} URLs.`);
    console.log('Results saved to dataset.');
});

// Helper function to validate email format
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$/;
    
    return emailRegex.test(email) && 
           !email.includes('example.') && 
           !email.includes('test.') &&
           !email.includes('.jpg') &&
           !email.includes('.png') &&
           !email.includes('.gif') &&
           email.length < 100 && // Reasonable length limit
           email.length > 5; // Minimum reasonable length
}

// Helper function to exclude unwanted emails
function isExcludedEmail(email) {
    const excludedDomains = [
        'revlocal.com', 'webflow.com', 'example.com', 'test.com', 
        'fake.com', 'localhost', 'sentry.io', 'hotjar.com',
        'google-analytics.com', 'googletagmanager.com'
    ];
    
    const excludedPrefixes = [
        'noreply', 'no-reply', 'donotreply', 'admin', 
        'webmaster', 'postmaster', 'support'
    ];
    
    const lowerEmail = email.toLowerCase();
    
    return excludedDomains.some(domain => lowerEmail.includes(domain)) ||
           excludedPrefixes.some(prefix => lowerEmail.startsWith(prefix));
}