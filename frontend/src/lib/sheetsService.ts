export function buildSheetRow(submission: any, photoDriveUrl: string | null): any[] {
  // Return columns in the exact order: A (submission_id) to AM (sync_status)
  return [
    submission.id || '', // Column A: submission_id
    submission.submitted_at || new Date().toISOString(), // Column B: submitted_at
    submission.supervisor_name || '', // Column C: supervisor_name
    submission.supervisor_email || '', // Column D: supervisor_email
    submission.zone || '', // Column E: zone
    submission.block || '', // Column F: block
    submission.plant_number || '', // Column G: plant_number
    submission.plant_id || '', // Column H: plant_id
    submission.common_name || 'Vanilla', // Column I: common_name
    submission.latin_name || 'Vanilla Planifolia', // Column J: latin_name
    submission.variety || 'Local', // Column K: variety
    submission.plant_type || 'Cutting', // Column L: plant_type
    submission.purchase_date || '', // Column M: purchase_date
    submission.planted_date || '', // Column N: planted_date
    submission.purchased_from || 'Goomaraya, Kandy District', // Column O: purchased_from
    submission.purchase_condition || '', // Column P: purchase_condition
    submission.watering_status || '', // Column Q: watering_status
    submission.sunlight_level || '', // Column R: sunlight_level
    submission.shade_level || '', // Column S: shade_level
    submission.soil_pH ?? submission.soil_ph ?? '', // Column T: soil_pH
    submission.soil_pH_recorded_at || '', // Column U: soil_pH_recorded_at
    submission.temperature_c || '', // Column V: temperature_c
    submission.temperature_recorded_at || '', // Column W: temperature_recorded_at
    submission.humidity_pct || '', // Column X: humidity_pct
    submission.humidity_recorded_at || '', // Column Y: humidity_recorded_at
    submission.soil_type || 'Acidic', // Column Z: soil_type
    Array.isArray(submission.fertiliser_type) ? submission.fertiliser_type.join(', ') : (submission.fertiliser_type || ''), // Column AA: fertiliser_type
    submission.last_fertilised || '', // Column AB: last_fertilised
    submission.fertiliser_used || '', // Column AC: fertiliser_used
    submission.vine_height_cm || '', // Column AD: vine_height_cm
    submission.height_delta_cm !== undefined && submission.height_delta_cm !== null ? submission.height_delta_cm : '', // Column AE: height_delta_cm
    submission.foliage_color || '', // Column AF: foliage_color
    submission.planting_arrangement || '', // Column AG: planting_arrangement
    submission.dead_support_trees || 0, // Column AH: dead_support_trees
    submission.dead_vines_count || 0, // Column AI: dead_vines_count
    submission.field_notes || '', // Column AJ: field_notes
    submission.photo_filename || '', // Column AK: photo_filename
    photoDriveUrl || submission.photo_drive_url || '', // Column AL: photo_drive_url
    'synced' // Column AM: sync_status
  ];
}

async function appendToRange(accessToken: string, spreadsheetId: string, range: string, rowData: any[]): Promise<any> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      values: [rowData]
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    const errText = await response.text();
    throw new Error(`Sheets API error: ${response.status} - ${errText}`);
  }

  return response.json();
}

export async function appendToSheets(accessToken: string, spreadsheetId: string, rowData: any[]): Promise<any> {
  // If in mock mode
  if (accessToken.startsWith('mock_')) {
    console.log('Mock: Appending row to Google Sheet', rowData);
    await new Promise(resolve => setTimeout(resolve, 800));
    return { success: true, mock: true, updatedCells: rowData.length };
  }

  try {
    // Try to append to 'Observations' tab first
    return await appendToRange(accessToken, spreadsheetId, 'Observations!A:AM', rowData);
  } catch (err: any) {
    // If the Observations sheet is missing, Google Sheets API returns a 400 Bad Request containing the tab name
    if (err.message && (err.message.includes('Observations') || err.message.includes('400'))) {
      console.warn('Observations sheet not found or failed. Retrying with fallback Sheet1...');
      try {
        return await appendToRange(accessToken, spreadsheetId, 'Sheet1!A:AM', rowData);
      } catch (fallbackErr: any) {
        throw new Error(`Sheets API error: Both Observations and Sheet1 tabs failed. ${fallbackErr.message}`);
      }
    }
    throw err;
  }
}

