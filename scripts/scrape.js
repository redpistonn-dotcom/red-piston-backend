import https from 'https';

https.get('https://redpiston.in', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const imgMatches = data.match(/<img[^>]+src="([^">]+)"/g) || [];
    const linkMatches = data.match(/<link[^>]+href="([^">]+)"/g) || [];
    console.log("Images:");
    imgMatches.slice(0, 10).forEach(m => console.log(m));
    console.log("Links:");
    linkMatches.forEach(m => console.log(m));
  });
});
