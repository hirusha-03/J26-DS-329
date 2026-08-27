import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        # Start a Playwright session in asynchronous mode
        pw = await async_api.async_playwright().start()

        # Launch a Chromium browser in headless mode with custom arguments
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )

        # Create a new browser context (like an incognito window)
        context = await browser.new_context()
        # Wider default timeout to match the agent's DOM-stability budget;
        # auto-waiting Playwright APIs (expect, locator.wait_for) inherit this.
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        # -> navigate
        await page.goto("http://localhost:3000")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Open the login page by navigating to '/login' (the page titled 'Sign In as Supervisor') so the supervisor can sign in.
        await page.goto("http://localhost:3000/login")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Fill the 'Supervisor Email' and 'Password' fields and click the 'Sign In as Supervisor' button.
        # supervisor@sapori.lk email field
        elem = page.locator('[id="email"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("example@gmail.com")
        
        # -> Fill the 'Supervisor Email' and 'Password' fields and click the 'Sign In as Supervisor' button.
        # •••••••• password field
        elem = page.locator('[id="password"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("password123")
        
        # -> Fill the 'Supervisor Email' and 'Password' fields and click the 'Sign In as Supervisor' button.
        # Sign In as Supervisor button
        elem = page.locator('[id="submit-login"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'Profile' link in the bottom navigation to open the Profile page.
        # Profile link
        elem = page.get_by_role('link', name='Profile', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify profile information is displayed
        # Assert: Profile initials 'CR' are visible on the profile card.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[1]/div[1]").nth(0)).to_have_text("CR", timeout=15000), "Profile initials 'CR' are visible on the profile card."
        # Assert: The Sign Out button is present with title 'Sign Out', indicating profile controls are displayed.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[1]/button").nth(0)).to_have_attribute("title", "Sign Out", timeout=15000), "The Sign Out button is present with title 'Sign Out', indicating profile controls are displayed."
        
        # --> Verify sync-related settings are displayed
        # Assert: The Google Spreadsheet ID input is displayed with its configured value.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[2]/form/div[1]/input").nth(0)).to_have_value("1o4--rtB8-AAhF5YkV2j9RGq8n1mRPV5EWCYGVi2k8-Q", timeout=15000), "The Google Spreadsheet ID input is displayed with its configured value."
        # Assert: A Zone Folder ID input is displayed with its configured value.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[2]/form/div[2]/div/div[1]/input").nth(0)).to_have_value("1ndIy-3aztLTyvsDnhzX_jt9H3LqcBsD7", timeout=15000), "A Zone Folder ID input is displayed with its configured value."
        # Assert: The 'Sync Pending Data' control is visible.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[3]/div[2]/div/div/button[1]").nth(0)).to_have_text("Sync Pending Data", timeout=15000), "The 'Sync Pending Data' control is visible."
        # Assert: The 'Clear Database Cache' control is visible.
        await expect(page.locator("xpath=/html/body/div[2]/main/div/div[2]/div[3]/div[2]/div/div/button[2]").nth(0)).to_have_text("Clear Database Cache", timeout=15000), "The 'Clear Database Cache' control is visible."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    