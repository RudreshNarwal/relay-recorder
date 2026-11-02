import sharp from 'sharp';
/** Decode only bounded raster formats. Re-encoding strips active content and metadata. */
export async function sanitizeLogo(input:Buffer){
 if(input.length>2_000_000||input.length<12)throw new Error('Choose a PNG, JPEG or WebP logo of at most 2 MB');
 const png=input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=input[0]===255&&input[1]===216&&input[2]===255,webp=input.toString('ascii',0,4)==='RIFF'&&input.toString('ascii',8,12)==='WEBP';
 if(!png&&!jpeg&&!webp)throw new Error('Choose a PNG, JPEG or WebP logo');
 const image=sharp(input,{limitInputPixels:4_000_000,failOn:'warning',animated:false});
 const info=await image.metadata();
 if(!info.width||!info.height||(info.pages??1)>1)throw new Error('Animated or invalid logos are unsupported');
 return image.rotate().resize(512,512,{fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();
}
