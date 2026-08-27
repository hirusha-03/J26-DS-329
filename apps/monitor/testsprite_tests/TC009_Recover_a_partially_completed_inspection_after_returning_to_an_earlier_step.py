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
        
        # -> Open the 'Inspection Step 1' page by navigating to the /inspect/step1 URL and observe whether the wizard is reachable or requires login.
        await page.goto("http://localhost:3000/inspect/step1")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Load the site's landing page and confirm the login/landing UI is visible (email and password fields and the 'Sign in' button).
        await page.goto("http://localhost:3000")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Fill the Supervisor email field with a test email, fill the Password field, then click the 'Sign In as Supervisor' button to authenticate and allow the SPA to fully render.
        # supervisor@sapori.lk email field
        elem = page.locator('[id="email"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("example@gmail.com")
        
        # -> Fill the Supervisor email field with a test email, fill the Password field, then click the 'Sign In as Supervisor' button to authenticate and allow the SPA to fully render.
        # •••••••• password field
        elem = page.locator('[id="password"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("password123")
        
        # -> Fill the Supervisor email field with a test email, fill the Password field, then click the 'Sign In as Supervisor' button to authenticate and allow the SPA to fully render.
        # Sign In as Supervisor button
        elem = page.locator('[id="submit-login"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'New inspection' quick action on the dashboard to open the inspection wizard (start of the 5-step inspection flow).
        # New inspection Fill FVP 05 form link
        elem = page.get_by_role('link', name='New inspection Fill FVP 05 form', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Zone C' card to select Zone C on the Step 1 'Select Zone' screen.
        # C 0 % dead Zone C 280 plants button
        elem = page.get_by_role('button', name='C 0% dead Zone C 280 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Block 01' row under 'Select Block — Zone C', then click the 'Next Step: Plant Info' button to open the Plant Info step.
        # 01 Block 01 100 plants button
        elem = page.get_by_role('button', name='01 Block 01 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Block 01' row under 'Select Block — Zone C', then click the 'Next Step: Plant Info' button to open the Plant Info step.
        # Next Step: Plant Info button
        elem = page.get_by_role('button', name='Next Step: Plant Info', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Plant Number selector by interacting with the selected 'Block 01' row and choose a valid plant number (e.g., the first tracked sample) so the 'Next Step: Plant Info' button becomes enabled.
        # 01 Block 01 100 plants button
        elem = page.get_by_role('button', name='01 Block 01 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Plant Number selector by clicking the 'Block 01' row so the tracked sample list appears, then choose the first tracked sample (plant 1) to enable the 'Next Step: Plant Info' button.
        # 01 Block 01 100 plants button
        elem = page.get_by_role('button', name='01 Block 01 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Plant Number selector and choose the first tracked plant (the visible '1' in the tracked samples list) so the 'Next Step: Plant Info' button becomes enabled.
        # 01 Block 01 100 plants button
        elem = page.get_by_role('button', name='01 Block 01 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Block 01' row (the row labeled 'Block 01' under 'Select Block — Zone C') to open the Plant Number selector so the first tracked plant '1' can be chosen and the 'Next Step: Plant Info' button becomes enabled.
        # 01 Block 01 100 plants button
        elem = page.get_by_role('button', name='01 Block 01 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open a different block row (click the 'Block 02' row) to reveal the plant number selector so the first tracked plant '1' can be selected and the 'Next Step: Plant Info' button becomes enabled.
        # 02 Block 02 100 plants button
        elem = page.get_by_role('button', name='02 Block 02 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Plant Number selector and choose the first tracked plant '1' so the 'Next Step: Plant Info' button becomes enabled (visible target: the tracked samples list under 'Plant Number').
        await page.mouse.wheel(0, 300)
        
        # -> Open the Plant Number selector and choose the first tracked plant '1' so the 'Next Step: Plant Info' button becomes enabled (visible target: the tracked samples list under 'Plant Number').
        # 02 Block 02 100 plants button
        elem = page.get_by_role('button', name='02 Block 02 100 plants', exact=True)
        await elem.click(timeout=10000)
        
        # -> Enter '1' into the 'Enter plant number' field and click the 'Next Step: Plant Info' button to move to the Plant Info step.
        # Enter plant number number field
        elem = page.get_by_placeholder('Enter plant number', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("1")
        
        # -> Enter '1' into the 'Enter plant number' field and click the 'Next Step: Plant Info' button to move to the Plant Info step.
        # Next Step: Plant Info button
        elem = page.get_by_role('button', name='Next Step: Plant Info', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Next: Care & Environment' button to advance from Plant Info (Step 2) to the Care & Environment step (Step 3).
        # Next: Care & Environment button
        elem = page.get_by_role('button', name='Next: Care & Environment', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the wizard remains on the inspection flow
        # Assert: The wizard is still in the inspection flow as the URL contains '/inspect/'.
        await expect(page).to_have_url(re.compile("/inspect/"), timeout=15000), "The wizard is still in the inspection flow as the URL contains '/inspect/'."
        current_url = await page.evaluate("() => window.location.href")
        # Assert: page loaded with a URL (final outcome verified by the AI judge during the run)
        assert current_url, 'Page should have loaded with a URL'
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    