$('#postForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#postSubmitBtn');
  const notice = $('#postNotice');
  notice.className = 'form-notice';
  notice.textContent = '';

  const fileInput = document.getElementById('pImages');
  const files = Array.from(fileInput.files);
  
  if (files.length === 0) { 
    notice.style.color = 'red'; 
    notice.textContent = 'Please upload at least 1 picture.'; 
    return; 
  }

  btn.disabled = true; 
  btn.textContent = 'Uploading pictures...';

  try {
    // 1. Send images to server
    const formData = new FormData();
    files.forEach(f => formData.append('images', f));

    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadRes.json();
    
    if (!uploadData.success) throw new Error("Image upload failed.");
    const uploadedImageUrls = uploadData.urls;

    btn.textContent = 'Saving property...';

    // 2. Send post data
    const rawPhone = $('#pOwnerPhone').value;
    const cleanPhone = rawPhone.replace(/[^0-9+]/g, '');

    const payload = {
      title: $('#pTitle').value, 
      purpose: $('#pPurpose').value, 
      type: $('#pType').value, 
      alexandraSuburb: $('#pTownship').value,
      location: $('#pTownship').value, 
      address: $('#pAddress').value,
      amount: $('#pPrice').value, 
      deposit: $('#pDeposit').value, 
      availableDate: $('#pAvailableDate').value, 
      notes: $('#pNotes').value,
      childFriendly: $('#pChild').value, 
      maxKids: $('#pChildCount').value || '0',
      parking: $('#pParking').value, 
      maxCars: $('#pCarCount').value || '0',
      ceiling: $('#pCeiling').value, 
      tiles: $('#pTiles').value,
      toiletType: $('#pToilet').value, 
      bathroomType: $('#pBathroom').value,
      posterName: $('#pOwnerName').value, 
      posterContact: cleanPhone,
      images: uploadedImageUrls, 
      video: "" 
    };

    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    
    if (res.ok && (data.ok || data.success || data.id)) {
      notice.style.color = 'var(--green-dark)'; 
      notice.textContent = '✅ Property submitted successfully! It will appear once approved.';
      e.target.reset(); 
      $('#imagePreview').innerHTML = '';
    } else {
      throw new Error(data.error || 'Could not submit property.');
    }
  } catch (err) {
    notice.style.color = 'var(--red)'; 
    notice.textContent = '⚠️ ' + (err.message || 'Failed to submit.');
  } finally { 
    btn.disabled = false; 
    btn.textContent = 'Submit Property for Approval'; 
  }
});
