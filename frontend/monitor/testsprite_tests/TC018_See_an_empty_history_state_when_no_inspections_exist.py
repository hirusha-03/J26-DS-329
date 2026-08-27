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
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        await page.goto("http://localhost:3000")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # Sign in
        elem = page.locator('[id="email"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("chandrapala542@gmail.com")
        
        elem = page.locator('[id="password"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("senuda2003")
        
        elem = page.locator('[id="submit-login"]')
        await elem.click(timeout=10000)
        
        # Navigate to Profile page to clear cache and set no_seed
        elem = page.get_by_role('link', name='Profile', exact=True)
        await elem.click(timeout=10000)

        # Set localStorage flag no_seed to true
        await page.evaluate("localStorage.setItem('no_seed', 'true')")

        # Set up a dialog handler to automatically confirm clearing cache
        async def handle_clear_dialog(dialog):
            if "CAUTION" in dialog.message or "confirm" in dialog.message:
                await dialog.accept()
            else:
                await dialog.dismiss()
        page.on("dialog", handle_clear_dialog)

        # Clear Database Cache
        elem = page.get_by_role('button', name='Clear Database Cache', exact=True)
        await elem.click(timeout=10000)
        # Wait a bit for cache clearing
        await asyncio.sleep(2)

        # Remove dialog handler
        page.remove_listener("dialog", handle_clear_dialog)

        # Verify Inspections counter is 0
        counter = page.locator('span:text-is("Inspections") + span')
        await expect(counter).to_have_text("0", timeout=10000)

        # Navigate to History page
        elem = page.get_by_role('link', name='History', exact=True)
        await elem.click(timeout=10000)
        
        # Verify the empty state message is displayed
        empty_msg = page.get_by_text("No records found matching filters.", exact=True)
        await expect(empty_msg).to_be_visible(timeout=15000)

        # Verify that B03-P012 and A01-P100 records are not visible
        await expect(page.get_by_text("Plant B03-P012")).not_to_be_visible(timeout=5000)
        await expect(page.get_by_text("Plant A01-P100")).not_to_be_visible(timeout=5000)

        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())