$body = @{
  service_user_name = "John Doe"
  dob = "1987-06-12"
  referral_source = "Hospital"
  referrer_name = "Dr Smith"
  referrer_contact = "123456"
  support_needs = "Housing support"
  urgency_level = "HIGH"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:3000/api/referrals" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
