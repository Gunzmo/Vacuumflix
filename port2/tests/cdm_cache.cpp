#define main cdmhost_program_main
#include "../cdmhost/cdmhost.cpp"
#undef main
#include <cassert>
static void u32(Bytes& b, uint32_t n) { b.insert(b.end(), {uint8_t(n>>24),uint8_t(n>>16),uint8_t(n>>8),uint8_t(n)}); }
static Bytes box(const char* type, Bytes payload) { Bytes b; u32(b, payload.size()+8); b.insert(b.end(), type, type+4); b.insert(b.end(), payload.begin(), payload.end()); return b; }
static Bytes join(Bytes a, const Bytes& b) { a.insert(a.end(), b.begin(), b.end()); return a; }
int main() {
    Bytes frma={'a','v','c','1'}, schm(4); schm.insert(schm.end(), {'c','e','n','c'}); u32(schm,0);
    Bytes tenc(24); tenc[6]=1; tenc[7]=8;
    Bytes sinf=join(box("frma",frma),join(box("schm",schm),box("schi",box("tenc",tenc))));
    Bytes entry(78); entry[25]=16; entry[27]=16;
    entry=join(entry,box("sinf",sinf));
    Bytes sd(4); u32(sd,1); sd=join(sd,box("encv",entry));
    Bytes init=box("moov",box("trak",box("mdia",box("minf",box("stbl",box("stsd",sd))))));
    std::vector<Bytes> result;
    // g_cdm is null: decrypt-only MUST NOT initialize a video decoder.
    assert(handle(OP_SET_INIT, {Bytes{'t'},init,Bytes{'d','e','c','r','y','p','t','-','o','n','l','y'}}, result)==0);
    assert(result.size()==4 && result[0].size()==init.size() && result[2].empty());
    assert(S(result[3])=="decrypt-only");
    assert(std::search(result[0].begin(), result[0].end(), frma.begin(), frma.end())!=result[0].end());
    assert(g_tracks.at("t").protected_);
    result.clear(); assert(handle(OP_DROP_TRACK,{Bytes{'t'}},result)==0); assert(!g_tracks.count("t"));

    // Explicit tfhd base_data_offset is absolute in a full file, relative in a sliced fragment.
    Bytes tfhd; u32(tfhd,0x11); u32(tfhd,1); u32(tfhd,0); u32(tfhd,1000); u32(tfhd,4);
    Bytes trun; u32(trun,1); u32(trun,1); u32(trun,0);
    Bytes senc; u32(senc,0); u32(senc,1);
    auto makeMoof=[&](){return box("moof",box("traf",join(box("tfhd",tfhd),join(box("trun",trun),box("senc",senc)))));};
    auto moof=makeMoof(); uint32_t dataoff=moof.size()+8;
    trun.resize(8); u32(trun,dataoff); moof=makeMoof();
    Bytes segment=join(moof,box("mdat",Bytes{1,2,3,4})); Track track; track.iv_size=0;
    std::string error; Bytes correct=segment;
    assert(decrypt_segment(track,correct,error,nullptr,nullptr,1000));
    Bytes wrong=segment; assert(!decrypt_segment(track,wrong,error,nullptr,nullptr,0));
    wrong=segment; assert(!decrypt_segment(track,wrong,error,nullptr,nullptr,2000));
    tfhd.clear(); u32(tfhd,0x11); u32(tfhd,1); u32(tfhd,0); u32(tfhd,0); u32(tfhd,4);
    trun.resize(8); u32(trun,1000+dataoff); segment=join(makeMoof(),box("mdat",Bytes{1,2,3,4}));
    assert(decrypt_segment(track,segment,error,nullptr,nullptr,1000));
    Bytes missing=box("moof",box("traf",join(box("tfhd",tfhd),box("trun",trun))));
    assert(!decrypt_segment(track,missing,error,nullptr,nullptr,1000,true));
    return 0;
}
