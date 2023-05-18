import SpikeCompressor from "./SpikeCompressor";

const SC = new SpikeCompressor();

const main = async () => {
    await SC.readData();    
}

main()