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
        
        # -> Open the inspection flow by navigating to /inspect/step1 and verify that the splash (login) page is shown instead of inspection content.
        await page.goto("http://localhost:3000/inspect/step1")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # --> Assertions to verify final state
        
        # --> Verify the splash page is displayed
        # Assert: The splash page header 'Vanilla Monitor' is visible.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[1]/div/div[1]/div[1]").nth(0)).to_contain_text("Vanilla Monitor", timeout=15000), "The splash page header 'Vanilla Monitor' is visible."
        await page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[1]/input").nth(0).scroll_into_view_if_needed()
        # Assert: The supervisor email input is visible.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[1]/input").nth(0)).to_be_visible(timeout=15000), "The supervisor email input is visible."
        await page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[2]/input").nth(0).scroll_into_view_if_needed()
        # Assert: The password input is visible.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[2]/input").nth(0)).to_be_visible(timeout=15000), "The password input is visible."
        await page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/button").nth(0).scroll_into_view_if_needed()
        # Assert: The 'Sign In as Supervisor' button is visible.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/button").nth(0)).to_be_visible(timeout=15000), "The 'Sign In as Supervisor' button is visible."
        
        # --> Verify access to the inspection flow is blocked
        # Assert: The supervisor email input shows the placeholder 'supervisor@sapori.lk'.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[1]/input").nth(0)).to_have_attribute("placeholder", "supervisor@sapori.lk", timeout=15000), "The supervisor email input shows the placeholder 'supervisor@sapori.lk'."
        # Assert: The password input is present and has type 'password'.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/div[2]/input").nth(0)).to_have_attribute("type", "password", timeout=15000), "The password input is present and has type 'password'."
        # Assert: The 'Sign In as Supervisor' button is visible on the splash page.
        await expect(page.locator("xpath=/html/body/div[2]/div[2]/div[2]/form/button").nth(0)).to_have_text("Sign In as Supervisor", timeout=15000), "The 'Sign In as Supervisor' button is visible on the splash page."
        # Assert: The current URL indicates the user is on the root splash page.
        await expect(page).to_have_url(re.compile("localhost:3000/"), timeout=15000), "The current URL indicates the user is on the root splash page."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    