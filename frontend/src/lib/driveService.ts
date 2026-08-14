export async function uploadPhotoToDrive(
  accessToken: string,
  photoBlob: Blob,
  zone: string,
  filename: string
): Promise<string> {
  // If in mock mode
  if (accessToken.startsWith('mock_')) {
    console.log(`Mock: Uploading photo to Google Drive [Zone ${zone}]`, filename);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return `https://drive.google.com/file/d/mock_drive_file_${Date.now()}/view`;
  }

  // Get zone folder ID from env
  const envKey = `NEXT_PUBLIC_DRIVE_ZONE_${zone}_FOLDER_ID`;
  const folderId = process.env[envKey] || localStorage.getItem(`drive_zone_${zone}_folder_id`) || '';

  const metadata = {
    name: filename,
    mimeType: photoBlob.type,
    parents: folderId ? [folderId] : []
  };

  const formData = new FormData();
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' })
  );
  formData.append('file', photoBlob);

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      body: formData
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    const errText = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  return `https://drive.google.com/file/d/${result.id}/view`;
}
