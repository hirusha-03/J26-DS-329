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
        
        # Log in
        elem = page.locator('[id="email"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("chandrapala542@gmail.com")
        
        elem = page.locator('[id="password"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("senuda2003")
        
        elem = page.locator('[id="submit-login"]')
        await elem.click(timeout=10000)
        
        # Go to Profile page
        elem = page.get_by_role('link', name='Profile', exact=True)
        await elem.click(timeout=10000)

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

        # Go back to Dashboard
        elem = page.get_by_role('link', name='Dashboard', exact=True)
        await elem.click(timeout=10000)

        # Click Go Offline button to toggle mock offline mode ON
        elem = page.locator('[id="toggle-offline-btn"]')
        # Wait until visible and check if it says Go Offline
        await elem.wait_for(state="visible", timeout=10000)
        if "Go Offline" in await elem.text_content():
            await elem.click(timeout=10000)
            await asyncio.sleep(1)

        # Verify offline banner is shown
        offline_banner = page.locator('[id="offline-banner"]')
        await expect(offline_banner).to_be_visible(timeout=10000)

        # Start a new inspection
        elem = page.get_by_role('link', name='New inspection Fill FVP 05 form', exact=True)
        await elem.click(timeout=10000)
        
        # Step 1 -> Step 2
        elem = page.get_by_role('button', name='Next Step: Plant Info', exact=True)
        await elem.click(timeout=10000)
        
        # Step 2 -> Step 3
        # Select Purchase Condition
        elem = page.get_by_role('button', name='>75%', exact=True)
        await elem.click(timeout=10000)
        # Go to Care & Env
        elem = page.get_by_role('button', name='Next: Care & Environment', exact=True)
        await elem.click(timeout=10000)
        
        # Step 3 -> Step 4
        # Select Watering
        elem = page.get_by_role('button', name='Keep moist', exact=True)
        await elem.click(timeout=10000)
        # Select Sunlight
        elem = page.get_by_role('button', name='Bright', exact=True)
        await elem.click(timeout=10000)
        # Select Shade
        elem = page.get_by_role('button', name='Shade <75%', exact=True)
        await elem.click(timeout=10000)
        # Go to Growth Tracker
        elem = page.get_by_role('button', name='Next: Growth Tracker', exact=True)
        await elem.click(timeout=10000)
        
        # Step 4 -> Step 5
        # Select Foliage Color
        elem = page.get_by_role('button', name='Green', exact=True)
        await elem.click(timeout=10000)
        # Select Arrangement
        elem = page.get_by_role('button', name='Square', exact=True)
        await elem.click(timeout=10000)
        # Go to Submit
        elem = page.get_by_role('button', name='Next: Photo & Submit', exact=True)
        await elem.click(timeout=10000)
        
        # Step 5 -> Success
        elem = page.get_by_role('button', name='Submit Inspection', exact=True)
        await elem.click(timeout=10000)

        # Verify success screen
        heading = page.locator('h1')
        await expect(heading).to_contain_text("Inspection Logged", timeout=15000)

        # Go to Profile
        elem = page.get_by_role('link', name='Profile', exact=True)
        await elem.click(timeout=10000)

        # Verify Inspections counter is 1
        counter = page.locator('span:text-is("Inspections") + span')
        await expect(counter).to_have_text("1", timeout=10000)

        # Turn mock offline mode OFF via localStorage
        await page.evaluate("localStorage.setItem('mock_offline', 'false')")

        # Set up a dialog handler to catch the alert dialog of sync complete
        sync_dialog_messages = []
        async def handle_sync_dialog(dialog):
            sync_dialog_messages.append(dialog.message)
            await dialog.accept()
        page.on("dialog", handle_sync_dialog)

        # Click the 'Sync Pending Data' button
        elem = page.locator('[id="sync-pending-btn"]')
        await elem.click(timeout=10000)

        # Wait a bit for the sync process and dialog to trigger
        await asyncio.sleep(5)

        # Verify sync complete message was shown
        assert len(sync_dialog_messages) > 0, "Expected a sync complete alert dialog to be shown."
        assert "Sync completed!" in sync_dialog_messages[0], f"Expected dialog message to indicate completion, got: {sync_dialog_messages[0]}"

        # Verify Inspections counter is still 1
        await expect(counter).to_have_text("1", timeout=10000)
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())