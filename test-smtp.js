import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false, // true for 465, false for other ports
  requireTLS: true,
  auth: {
    user: 'trainings.ke@edgevest.co.ke',
    pass: 'tdpswczcrcpbfygs'
  },
  tls: { rejectUnauthorized: false }
});

// Verify connection
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Error:', error.message);
  } else {
    console.log('✅ SMTP connection successful!');
  }
});